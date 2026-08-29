import {
  ErrorEnvelopeSchema,
  type ErrorEnvelope,
  type OrchestratorErrorCode
} from "@unified-ai/contracts";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";

export class ApiError extends Error {
  readonly status: number;
  readonly code: OrchestratorErrorCode;
  readonly retryable: boolean;

  constructor(
    status: number,
    code: OrchestratorErrorCode,
    message: string,
    retryable = false
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function errorEnvelope(
  code: OrchestratorErrorCode,
  message: string,
  retryable: boolean
): ErrorEnvelope {
  return ErrorEnvelopeSchema.parse({ error: { code, message, retryable } });
}

export const notFoundHandler: RequestHandler = (_request, response) => {
  response
    .status(404)
    .json(errorEnvelope("invalid_request", "The requested local API route does not exist.", false));
};

export const errorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  _next
) => {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof ApiError) {
    response
      .status(error.status)
      .json(errorEnvelope(error.code, error.message, error.retryable));
    return;
  }
  if (error instanceof ZodError) {
    response
      .status(400)
      .json(errorEnvelope("invalid_request", "The request failed schema validation.", false));
    return;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 413 &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    response
      .status(413)
      .json(
        errorEnvelope(
          "invalid_request",
          "The JSON request exceeds the 1 MiB limit.",
          false
        )
      );
    return;
  }
  response
    .status(500)
    .json(errorEnvelope("internal_error", "The local orchestrator request failed safely.", false));
};
