import type { ModelMessage } from "ai";

const STUB_TOOLS = new Set([
  "search",
  "fetch",
  "read_source",
  "search_sources",
  "run_code",
]);

function stubPart(part: Record<string, unknown>): Record<string, unknown> {
  const name = String(part.toolName ?? "tool");
  const stub = `[${name} result paged out — the sources it produced are stored; reopen them with search_sources or read_source]`;
  return { ...part, output: { type: "text", value: stub } };
}

export function stubToolResultWindow(
  messages: ModelMessage[],
  keep: number,
): ModelMessage[] {
  const positions: string[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool" && Array.isArray(m.content)) {
      (m.content as Array<Record<string, unknown>>).forEach((part, k) => {
        if (
          part?.type === "tool-result" &&
          STUB_TOOLS.has(String(part.toolName))
        ) {
          positions.push(`${i}:${k}`);
        }
      });
    }
  });
  if (positions.length <= keep) return messages;
  const keepSet = new Set(positions.slice(positions.length - keep));
  return messages.map((m, i) => {
    if (m.role !== "tool" || !Array.isArray(m.content)) return m;
    const content = (m.content as Array<Record<string, unknown>>).map(
      (part, k) =>
        part?.type === "tool-result" &&
        STUB_TOOLS.has(String(part.toolName)) &&
        !keepSet.has(`${i}:${k}`)
          ? stubPart(part)
          : part,
    );
    return { ...m, content } as ModelMessage;
  });
}
