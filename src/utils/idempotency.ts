export type IdempotencyParseResult =
  | { ok: true; key: string | null }
  | { ok: false; error: string };

const MAX_KEY_LEN = 255;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

export function parseIdempotencyHeader(value: string | undefined): IdempotencyParseResult {
  if (value === undefined) return { ok: true, key: null };
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Idempotency-Key must not be empty" };
  }
  if (trimmed.length > MAX_KEY_LEN) {
    return { ok: false, error: `Idempotency-Key must be ≤${MAX_KEY_LEN} chars` };
  }
  if (!PRINTABLE_ASCII.test(trimmed)) {
    return { ok: false, error: "Idempotency-Key must be printable ASCII" };
  }
  return { ok: true, key: trimmed };
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const view = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, "0");
  return out;
}

// Deterministic 30-char job_id derived from idempotency key. The "idem_"
// prefix lets `GET /v1/<op>/<id>` consumers visually distinguish replayed
// jobs from fresh ULIDs.
export async function deriveJobIdFromKey(key: string): Promise<string> {
  const h = await sha256Hex(key);
  return `idem_${h.slice(0, 25)}`;
}
