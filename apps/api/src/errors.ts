import {
  ErrorEnvelopeSchema,
  type ErrorEnvelope,
  type OrchestratorErrorCode
} from "@unified-ai/contracts";
import {
  DashboardConflictDetailsSchema,
  DashboardErrorEnvelopeSchema,
  type DashboardErrorEnvelope
} from "@unified-ai/contracts/dashboard-builder";
import { DashboardBuilderError } from "@unified-ai/dashboard-builder";
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

function dashboardErrorEnvelope(
  code: DashboardErrorEnvelope["error"]["code"],
  message: string,
  retryable: boolean,
  details: DashboardErrorEnvelope["error"]["details"] = null
): DashboardErrorEnvelope {
  return DashboardErrorEnvelopeSchema.parse({
    error: { code, message, retryable, details }
  });
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
  if (error instanceof DashboardBuilderError) {
    if (error.code === "revision-conflict") {
      const details = DashboardConflictDetailsSchema.safeParse(error.details);
      response.status(409).json(
        dashboardErrorEnvelope(
          "revision-conflict",
          "The dashboard draft changed before this request completed.",
          false,
          details.success ? details.data : null
        )
      );
      return;
    }
    if (error.code === "dashboard-validation-failed") {
      response.status(422).json(
        dashboardErrorEnvelope(
          "dashboard-validation-failed",
          "The dashboard manifest failed validation.",
          false
        )
      );
      return;
    }
    if (error.code === "adapter-unavailable") {
      response.status(503).json(
        dashboardErrorEnvelope(
          "adapter-unavailable",
          "The requested dashboard adapter is unavailable.",
          true
        )
      );
      return;
    }
    if (error.code === "evidence-integrity-failed") {
      response.status(500).json(
        dashboardErrorEnvelope(
          "evidence-integrity-failed",
          "Dashboard evidence failed integrity verification.",
          false
        )
      );
      return;
    }
    if (error.code === "unsupported-schema-version") {
      response.status(400).json(
        dashboardErrorEnvelope(
          "unsupported-schema-version",
          "The dashboard schema version is not supported.",
          false
        )
      );
      return;
    }
    if (error.code === "template-not-found") {
      response
        .status(404)
        .json(
          errorEnvelope(
            "invalid_request",
            "The requested dashboard record was not found.",
            false
          )
        );
      return;
    }
    response
      .status(400)
      .json(errorEnvelope("invalid_request", "The dashboard request is invalid.", false));
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
  if (
    error instanceof URIError ||
    (typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 400 &&
      "type" in error &&
      error.type === "entity.parse.failed")
  ) {
    response
      .status(400)
      .json(errorEnvelope("invalid_request", "The request contains invalid JSON or encoding.", false));
    return;
  }
  response
    .status(500)
    .json(errorEnvelope("internal_error", "The local orchestrator request failed safely.", false));
};
