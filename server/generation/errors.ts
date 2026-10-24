export type GenerationErrorCode =
  | "bad_key"
  | "no_credits"
  | "subscription"
  | "workflow"
  | "upstream"
  | "cancelled";

export class GenerationError extends Error {
  readonly code: GenerationErrorCode;
  readonly status: number;

  constructor(message: string, code: GenerationErrorCode, status = 0) {
    super(message);
    this.name = "GenerationError";
    this.code = code;
    this.status = status;
  }
}
