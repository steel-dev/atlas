import type Steel from "steel-sdk";
import { vi } from "vitest";
import {
  createAgentScope,
  createResearchCaches,
  createSourceReservations,
  type ResearchCtx,
} from "./runtime.js";
import type { SourceDocument } from "./sources.js";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function markdownToHtml(markdown: string): string {
  return markdown
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (trimmed.startsWith("# ")) {
        return `<h1>${escapeHtml(trimmed.slice(2))}</h1>`;
      }
      return `<p>${escapeHtml(trimmed)}</p>`;
    })
    .join("");
}

export interface ToolTestContext extends ResearchCtx {
  emitSpy: ReturnType<typeof vi.fn>;
  queueSpy: ReturnType<typeof vi.fn>;
}

export function createToolTestContext(opts: {
  scrape?: ReturnType<typeof vi.fn>;
  sourceDocuments?: Map<string, SourceDocument>;
  sourceCap?: number;
  useProxy?: boolean;
}): ToolTestContext {
  const scrape = opts.scrape ?? vi.fn();
  let currentUrl = "about:blank";
  let currentTitle = "";
  let currentHtml = "<html><head><title></title></head><body></body></html>";
  const browserSessionPool = {
    acquire: vi.fn(async () => ({
      resource: {
        session: { id: "session_test" },
        cdpSessionId: "cdp_session_test",
        lastUsedAt: Date.now(),
        client: {
          waitForEvent: vi.fn(async () => undefined),
          send: vi.fn(
            async (method: string, params?: Record<string, unknown>) => {
              if (method === "Page.navigate") {
                currentUrl = String(params?.url ?? currentUrl);
                const rendered = await scrape(
                  {
                    url: currentUrl,
                    format: ["markdown"],
                    useProxy: opts.useProxy ?? false,
                  },
                  { signal: undefined },
                );
                const content =
                  (
                    rendered as {
                      content?: { markdown?: string; html?: string };
                      metadata?: { title?: string };
                    }
                  )?.content ?? {};
                currentTitle = String(
                  (rendered as { metadata?: { title?: string } })?.metadata
                    ?.title ?? currentUrl,
                );
                currentHtml =
                  content.html ??
                  `<html><head><title>${escapeHtml(currentTitle)}</title></head><body><main>${markdownToHtml(content.markdown ?? "")}</main></body></html>`;
                return {};
              }
              if (method === "Runtime.evaluate") {
                const expression = String(params?.expression ?? "");
                if (expression.includes("innerText.length")) {
                  return { result: { value: currentHtml.length } };
                }
                return {
                  result: {
                    value: {
                      url: currentUrl,
                      title: currentTitle,
                      html: currentHtml,
                    },
                  },
                };
              }
              return {};
            },
          ),
        },
      },
      release: vi.fn(async () => undefined),
    })),
  };
  const emit = vi.fn();
  const queueSpy = vi.fn();
  const sourceDocuments = opts.sourceDocuments ?? new Map();
  return {
    config: {
      useProxy: opts.useProxy ?? false,
      sourceCap: opts.sourceCap ?? 4,
      maxConcurrentTools: 2,
    },
    deps: {
      model: {
        provider: "anthropic",
        model: "test-model",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        step: vi.fn(),
      },
      steel: { sessions: {}, scrape } as unknown as Steel,
      throwIfAborted: vi.fn(),
      ioGate: { run: (fn) => fn() },
      browserSessionPool:
        browserSessionPool as unknown as ResearchCtx["deps"]["browserSessionPool"],
    },
    store: {
      fetchedSources: [],
      sourceDocuments,
      sourceDocumentsById: new Map(
        Array.from(sourceDocuments.values()).map((document) => [
          document.sourceId,
          document,
        ]),
      ),
      sourceReservations: createSourceReservations(),
      caches: createResearchCaches(),
      claims: {
        claims: [],
        unsupportedCount: 0,
        queue: queueSpy,
        settle: async () => {},
      },
    },
    scope: createAgentScope({ sink: emit, query: "test question" }),
    emitSpy: emit,
    queueSpy,
  } as ToolTestContext;
}
