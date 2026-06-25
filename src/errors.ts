export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type AtlasErrorCode =
  | "config"
  | "budget"
  | "resume"
  | "aborted"
  | "paused"
  | "timeout";

export class AtlasError extends Error {
  constructor(
    message: string,
    readonly code: AtlasErrorCode,
  ) {
    super(message);
    this.name = "AtlasError";
  }
}
