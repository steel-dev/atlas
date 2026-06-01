import type { CdpCommandOptions } from "./browser-cdp.js";
import {
  BrowserSessionPool,
  defaultBrowserMaxSessions,
  readBrowserMaxSessionsFromEnv,
} from "./browser-session-pool.js";
import { errorMessage } from "./errors.js";
import { htmlToMarkdown } from "./html-extract.js";
import type { ResearchCtx, SourceCacheEntry } from "./runtime.js";
import type { SourceExtractionAttempt } from "./sources.js";
import { extractionMetadataFromBrowser } from "./source-documents.js";
import { runSteelRequest } from "./steel-runtime.js";

const NAVIGATION_TIMEOUT_MS = 20_000;
const SETTLE_TIMEOUT_MS = 5_000;
const SETTLE_POLL_MS = 500;
const BROWSER_EXTRACTION_ATTEMPTS = 2;

interface RuntimeEvaluateResult {
  result?: {
    value?: unknown;
  };
  exceptionDetails?: {
    text?: string;
  };
}

interface PageSnapshot {
  url: string;
  title: string;
  html: string;
}

export async function extractSourceWithBrowser(
  ctx: ResearchCtx,
  url: string,
  previousAttempts: SourceExtractionAttempt[],
): Promise<SourceCacheEntry> {
  return runSteelRequest(ctx, async () => {
    const attempts = [...previousAttempts];
    for (let attempt = 1; attempt <= BROWSER_EXTRACTION_ATTEMPTS; attempt++) {
      const outcome = await extractSourceOnce(ctx, url, attempts);
      if (outcome.ok) return outcome.entry;
      attempts.push(outcome.attempt);
      if (
        !isTransientBrowserError(outcome.error) ||
        attempt >= BROWSER_EXTRACTION_ATTEMPTS
      ) {
        return {
          markdown: "",
          title: null,
          metadata: extractionMetadataFromBrowser({
            markdownChars: 0,
            attempts,
          }),
        };
      }
    }
    return {
      markdown: "",
      title: null,
      metadata: extractionMetadataFromBrowser({
        markdownChars: 0,
        attempts,
      }),
    };
  });
}

export async function extractHtmlWithBrowser(
  ctx: ResearchCtx,
  url: string,
): Promise<{ html: string; finalUrl: string; title: string }> {
  return runSteelRequest(ctx, async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= BROWSER_EXTRACTION_ATTEMPTS; attempt++) {
      try {
        return await extractHtmlOnce(ctx, url);
      } catch (err) {
        lastError = err;
        if (
          !isTransientBrowserError(err) ||
          attempt >= BROWSER_EXTRACTION_ATTEMPTS
        ) {
          throw err;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(errorMessage(lastError));
  });
}

type SourceExtractionOutcome =
  | { ok: true; entry: SourceCacheEntry }
  | { ok: false; attempt: SourceExtractionAttempt; error: unknown };

async function extractSourceOnce(
  ctx: ResearchCtx,
  url: string,
  previousAttempts: SourceExtractionAttempt[],
): Promise<SourceExtractionOutcome> {
  const pool = getBrowserSessionPool(ctx);
  const lease = await pool.acquire();
  let discard = false;
  try {
    await navigateToUrl(lease.resource, url);
    const snapshot = await extractCurrentPage(lease.resource);
    const extracted = htmlToMarkdown(snapshot.html, snapshot.url);
    const attempts = [
      ...previousAttempts,
      {
        method: "browser_cdp",
        ok: Boolean(extracted.markdown),
        note: extracted.markdown
          ? `browser_cdp: extracted ${extracted.markdown.length} markdown chars`
          : "empty_markdown: browser session returned empty markdown",
      },
    ];
    return {
      ok: true,
      entry: {
        markdown: extracted.markdown,
        title: extracted.title || snapshot.title || snapshot.url,
        metadata: extractionMetadataFromBrowser({
          markdownChars: extracted.markdown.length,
          finalUrl: snapshot.url,
          attempts,
          discoveredLinks: extracted.links,
          pageMetadata: extracted.metadata,
        }),
      },
    };
  } catch (err) {
    discard = true;
    return {
      ok: false,
      error: err,
      attempt: {
        method: "browser_cdp",
        ok: false,
        note: `browser_error: ${errorMessage(err)}`,
      },
    };
  } finally {
    await lease.release({ discard });
  }
}

async function extractHtmlOnce(
  ctx: ResearchCtx,
  url: string,
): Promise<{ html: string; finalUrl: string; title: string }> {
  const pool = getBrowserSessionPool(ctx);
  const lease = await pool.acquire();
  let discard = false;
  try {
    await navigateToUrl(lease.resource, url);
    const snapshot = await extractCurrentPage(lease.resource);
    return {
      html: snapshot.html,
      finalUrl: snapshot.url,
      title: snapshot.title,
    };
  } catch (err) {
    discard = true;
    throw err;
  } finally {
    await lease.release({ discard });
  }
}

function getBrowserSessionPool(ctx: ResearchCtx): BrowserSessionPool {
  if (!ctx.deps.browserSessionPool) {
    ctx.deps.browserSessionPool = new BrowserSessionPool({
      steel: ctx.deps.steel,
      useProxy: ctx.config.useProxy,
      namespace: `atlas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      signal: ctx.deps.signal,
      deadlineAt: ctx.scope.deadlineAt,
      maxSessions:
        readBrowserMaxSessionsFromEnv() ??
        defaultBrowserMaxSessions(ctx.config.maxConcurrentSubagents),
    });
  }
  return ctx.deps.browserSessionPool;
}

export async function navigateToUrl(
  resource: {
    client: {
      send: <T>(
        method: string,
        params?: Record<string, unknown>,
        opts?: CdpCommandOptions,
      ) => Promise<T>;
      waitForEvent: <T>(
        method: string,
        opts?: { sessionId?: string; timeoutMs?: number },
      ) => Promise<T>;
    };
    cdpSessionId?: string;
  },
  url: string,
): Promise<void> {
  const opts = commandOpts(resource);
  const domReady = resource.client
    .waitForEvent("Page.domContentEventFired", {
      ...opts,
      timeoutMs: NAVIGATION_TIMEOUT_MS,
    })
    .catch(() => undefined);
  const loaded = resource.client
    .waitForEvent("Page.loadEventFired", {
      ...opts,
      timeoutMs: NAVIGATION_TIMEOUT_MS,
    })
    .catch(() => undefined);
  await resource.client.send<{ errorText?: string }>(
    "Page.navigate",
    { url },
    { ...opts, timeoutMs: NAVIGATION_TIMEOUT_MS },
  );
  await Promise.race([domReady, loaded, delay(NAVIGATION_TIMEOUT_MS)]);
  await settlePage(resource);
}

async function settlePage(resource: {
  client: {
    send: <T>(
      method: string,
      params?: Record<string, unknown>,
      opts?: CdpCommandOptions,
    ) => Promise<T>;
  };
  cdpSessionId?: string;
}): Promise<void> {
  const startedAt = Date.now();
  let lastLength = -1;
  let stableSamples = 0;
  while (Date.now() - startedAt < SETTLE_TIMEOUT_MS) {
    const length = await evaluate<number>(
      resource,
      "document.body ? document.body.innerText.length : 0",
    ).catch(() => 0);
    if (length > 0 && length === lastLength) {
      stableSamples++;
      if (stableSamples >= 2) return;
    } else {
      stableSamples = 0;
      lastLength = length;
    }
    await delay(SETTLE_POLL_MS);
  }
}

export async function extractCurrentPage(resource: {
  client: {
    send: <T>(
      method: string,
      params?: Record<string, unknown>,
      opts?: CdpCommandOptions,
    ) => Promise<T>;
  };
  cdpSessionId?: string;
}): Promise<PageSnapshot> {
  const snapshot = await evaluate<PageSnapshot>(
    resource,
    `(() => ({
      url: location.href,
      title: document.title,
      html: document.documentElement ? document.documentElement.outerHTML : ""
    }))()`,
  );
  return {
    url: String(snapshot.url || "about:blank"),
    title: String(snapshot.title || snapshot.url || ""),
    html: String(snapshot.html || ""),
  };
}

async function evaluate<T>(
  resource: {
    client: {
      send: <R>(
        method: string,
        params?: Record<string, unknown>,
        opts?: CdpCommandOptions,
      ) => Promise<R>;
    };
    cdpSessionId?: string;
  },
  expression: string,
): Promise<T> {
  const result = await resource.client.send<RuntimeEvaluateResult>(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    commandOpts(resource),
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed");
  }
  return result.result?.value as T;
}

function commandOpts(resource: { cdpSessionId?: string }): CdpCommandOptions {
  return resource.cdpSessionId ? { sessionId: resource.cdpSessionId } : {};
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientBrowserError(err: unknown): boolean {
  const message = errorMessage(err);
  if (/aborted|aborterror/i.test(message)) return false;
  return (
    /Unexpected server response:\s*(?:502|503|504)/i.test(message) ||
    /\b(?:CDP connection closed|session timeout|timed out|timeout|ECONNRESET|ETIMEDOUT|socket hang up)\b/i.test(
      message,
    )
  );
}
