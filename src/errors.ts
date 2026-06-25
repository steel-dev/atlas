export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AtlasError extends Error {
  constructor(
    message: string,
    readonly code:
      | "config"
      | "budget"
      | "resume"
      | "cancelled"
      | "paused"
      | "timeout",
  ) {
    super(message);
    this.name = "AtlasError";
  }
}

export class ConfigError extends AtlasError {
  constructor(message: string) {
    super(message, "config");
    this.name = "ConfigError";
  }
}

export class ResumeError extends AtlasError {
  constructor(message: string) {
    super(message, "resume");
    this.name = "ResumeError";
  }
}

export class BudgetExceededError extends AtlasError {
  constructor(message: string) {
    super(message, "budget");
    this.name = "BudgetExceededError";
  }
}
