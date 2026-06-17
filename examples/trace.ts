#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";

const ROOT = join("eval-runs", "traces");

const USAGE = `atlas trace — inspect per-commit run traces captured by \`--trace\`

Usage:
  tsx examples/trace.ts <command> [options]

Overview (cheap, start here):
  commits                       Commit dirs that have traces, with run counts
  list [--commit SHA]           Runs for a commit (default: current HEAD):
                                wall / cost / waitRatio / peak / top anomaly

Per-run (get <runId> from \`list\`):
  digest <runId>                Bottleneck digest: critical path, phase
                                breakdown, wait-vs-compute, anomalies + code sites
  spans <runId> [--kind K] [--grep RE]
                                Raw timing spans (K=model|tool|io|agent)

Transcript (byte-exact model steps — sliced):
  transcript <runId>            Summary: steps per role + seq ranges (no dump)
  transcript <runId> --role R | --seq A-B | --step N | --grep RE | --head N
                                Matching steps' reasoning + tool calls;
                                add --messages for the byte-exact input thread

Traces are produced by:
  tsx examples/cli.ts "<question>" --trace full
`;

interface Flags {
  commit?: string;
  kind?: string;
  grep?: string;
  role?: string;
  seq?: string;
  step?: string;
  head?: string;
  messages: boolean;
}

interface DigestLite {
  wallMs: number;
  costUSD: number;
  waitVsCompute: { ratio: number };
  concurrency: { peakModelInFlight: number; gateLimitModel: number };
  anomalies: Array<{ kind: string; site?: string }>;
}

interface TranscriptStep {
  seq: number;
  atMs: number;
  role: string;
  adapter: string;
  durationMs: number;
  system: string;
  messages: unknown[];
  toolNames?: string[];
  maxTokens: number;
  outputSchema?: string;
  output: Array<Record<string, unknown>>;
  inputTokens?: number;
  error?: string;
}

function fail(message: string): never {
  process.stderr.write(`atlas-trace: ${message}\n`);
  process.exit(1);
}

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function raw(text: string): void {
  process.stdout.write(text + "\n");
}

function need(positionals: string[], index: number, name: string): string {
  const value = positionals[index];
  if (!value) fail(`missing <${name}>`);
  return value;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function currentCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function commitDirs(): string[] {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function findFile(runId: string, suffix: string): string {
  for (const c of commitDirs()) {
    const p = join(ROOT, c, `${runId}.${suffix}`);
    if (existsSync(p)) return p;
  }
  fail(`no ${suffix} for run ${runId} under ${ROOT}/*/ — was it run with --trace?`);
}

function cmdCommits(): void {
  const head = currentCommit();
  const rows = commitDirs().map((c) => ({
    commit: c,
    runs: readdirSync(join(ROOT, c)).filter((f) => f.endsWith(".digest.json"))
      .length,
    ...(c === head ? { head: true } : {}),
  }));
  if (rows.length === 0) raw(`(no traces yet under ${ROOT}/ — run with --trace)`);
  else out(rows);
}

function cmdList(flags: Flags): void {
  const commit = flags.commit ?? currentCommit();
  if (!commit) fail("could not resolve a commit — pass --commit SHA");
  const dir = join(ROOT, commit);
  if (!existsSync(dir)) {
    fail(
      `no traces for commit ${commit} — produce one with \`tsx examples/cli.ts "<q>" --trace full\`, or pass --commit`,
    );
  }
  const runs = readdirSync(dir)
    .filter((f) => f.endsWith(".digest.json"))
    .map((f) => {
      const j = readJson(join(dir, f)) as {
        runId?: string;
        question?: string;
        digest?: DigestLite | null;
      };
      const d = j.digest ?? undefined;
      const top = d?.anomalies?.[0];
      return {
        runId: j.runId ?? f.replace(/\.digest\.json$/, ""),
        question: (j.question ?? "").slice(0, 80),
        wallMs: d?.wallMs ?? null,
        costUSD: d?.costUSD ?? null,
        waitRatio: d?.waitVsCompute?.ratio ?? null,
        peakModel: d
          ? `${d.concurrency.peakModelInFlight}/${d.concurrency.gateLimitModel}`
          : null,
        anomalies: d?.anomalies?.length ?? 0,
        topAnomaly: top ? `${top.kind}${top.site ? `@${top.site}` : ""}` : null,
      };
    });
  out({ commit, runs });
}

function cmdDigest(positionals: string[]): void {
  const j = readJson(
    findFile(need(positionals, 1, "runId"), "digest.json"),
  ) as { digest?: unknown };
  out(j.digest ?? null);
}

function cmdSpans(positionals: string[], flags: Flags): void {
  const j = readJson(
    findFile(need(positionals, 1, "runId"), "trace.json"),
  ) as { spans?: Array<Record<string, unknown>> };
  let spans = j.spans ?? [];
  if (flags.kind) spans = spans.filter((s) => s.kind === flags.kind);
  if (flags.grep) {
    const re = new RegExp(flags.grep, "i");
    spans = spans.filter((s) => re.test(JSON.stringify(s)));
  }
  out(spans);
}

function renderBlock(block: Record<string, unknown>): string {
  switch (block.type) {
    case "thinking":
      return `  [thinking] ${block.thinking}`;
    case "redacted_thinking":
      return `  [thinking redacted]`;
    case "text":
      return `  [text] ${block.text}`;
    case "tool_call":
      return `  [tool_call ${block.name}] ${JSON.stringify(block.input)}`;
    default:
      return `  [${String(block.type)}]`;
  }
}

function renderStep(step: TranscriptStep, includeMessages: boolean): string {
  const head =
    `#${step.seq} [${step.role}] ${step.adapter} +${step.atMs}ms ` +
    `dur=${step.durationMs}ms` +
    (step.inputTokens !== undefined ? ` in=${step.inputTokens}tok` : "") +
    (step.outputSchema ? ` schema=${step.outputSchema}` : "") +
    (step.toolNames ? ` tools=[${step.toolNames.join(",")}]` : "");
  const lines = [head, ...step.output.map(renderBlock)];
  if (step.error) lines.push(`  [error] ${step.error}`);
  if (includeMessages) {
    lines.push("  [messages]");
    lines.push(JSON.stringify(step.messages, null, 2));
  }
  return lines.join("\n");
}

function cmdTranscript(positionals: string[], flags: Flags): void {
  const j = readJson(
    findFile(need(positionals, 1, "runId"), "trace.json"),
  ) as { steps?: TranscriptStep[] };
  const steps = j.steps ?? [];
  const selecting =
    flags.role || flags.seq || flags.step || flags.grep || flags.head;

  if (!selecting) {
    const byRole = new Map<string, number[]>();
    for (const s of steps) {
      const arr = byRole.get(s.role) ?? [];
      arr.push(s.seq);
      byRole.set(s.role, arr);
    }
    out({
      totalSteps: steps.length,
      roles: [...byRole.entries()].map(([role, seqs]) => ({
        role,
        steps: seqs.length,
        seqRange: [Math.min(...seqs), Math.max(...seqs)],
      })),
      hint: "select steps with --role R | --seq A-B | --step N | --grep RE | --head N; add --messages for the byte-exact input thread",
    });
    return;
  }

  let selected = steps;
  if (flags.role) selected = selected.filter((s) => s.role === flags.role);
  if (flags.step !== undefined) {
    const n = Number(flags.step);
    selected = selected.filter((s) => s.seq === n);
  }
  if (flags.seq) {
    const [a, b] = flags.seq.split("-").map(Number);
    const hi = Number.isFinite(b) ? b : a;
    selected = selected.filter((s) => s.seq >= a && s.seq <= hi);
  }
  if (flags.grep) {
    const re = new RegExp(flags.grep, "i");
    selected = selected.filter(
      (s) =>
        re.test(JSON.stringify(s.output)) || re.test(JSON.stringify(s.messages)),
    );
  }
  if (flags.head) selected = selected.slice(0, Number(flags.head));

  if (selected.length === 0) {
    raw("(no steps matched)");
    return;
  }
  raw(selected.map((s) => renderStep(s, flags.messages)).join("\n\n"));
}

function main(): void {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      commit: { type: "string" },
      kind: { type: "string" },
      grep: { type: "string" },
      role: { type: "string" },
      seq: { type: "string" },
      step: { type: "string" },
      head: { type: "string" },
      messages: { type: "boolean" },
    },
  });
  const flags: Flags = {
    commit: values.commit,
    kind: values.kind,
    grep: values.grep,
    role: values.role,
    seq: values.seq,
    step: values.step,
    head: values.head,
    messages: values.messages ?? false,
  };
  const command = positionals[0];
  switch (command) {
    case "commits":
      return cmdCommits();
    case "list":
      return cmdList(flags);
    case "digest":
      return cmdDigest(positionals);
    case "spans":
      return cmdSpans(positionals, flags);
    case "transcript":
      return cmdTranscript(positionals, flags);
    default:
      process.stdout.write(USAGE);
      if (command) fail(`unknown command: ${command}`);
  }
}

main();
