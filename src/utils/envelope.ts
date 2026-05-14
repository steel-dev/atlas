export type Envelope<T> =
  | { success: true; data: T; request_id: string }
  | { success: false; error: string; code: string; request_id: string };

export function envelopeOk<T>(data: T, request_id: string): Envelope<T> {
  return { success: true, data, request_id };
}

export function envelopeFail(
  code: string,
  error: string,
  request_id: string,
): Envelope<never> {
  return { success: false, error, code, request_id };
}
