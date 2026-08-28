export type OllamaClientErrorCode =
  | "invalid_configuration"
  | "runtime_offline"
  | "request_timeout"
  | "aborted"
  | "upstream_error"
  | "invalid_response"
  | "model_missing"
  | "model_mismatch";

export interface OllamaClientErrorOptions {
  readonly retryable: boolean;
  readonly status?: number;
}

/**
 * A deliberately small, body-safe error surfaced by the Ollama transport.
 *
 * Request prompts and response bodies must never be attached to this error.
 */
export class OllamaClientError extends Error {
  readonly code: OllamaClientErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(
    code: OllamaClientErrorCode,
    message: string,
    options: OllamaClientErrorOptions
  ) {
    super(message);
    this.name = "OllamaClientError";
    this.code = code;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export function invalidResponse(message: string): OllamaClientError {
  return new OllamaClientError("invalid_response", message, {
    retryable: false
  });
}
