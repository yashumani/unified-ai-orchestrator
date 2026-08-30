export type DashboardBuilderErrorCode =
  | "adapter-unavailable"
  | "dashboard-validation-failed"
  | "evidence-integrity-failed"
  | "invalid-dashboard-request"
  | "revision-conflict"
  | "template-not-found"
  | "unsupported-schema-version";

export interface DashboardBuilderErrorDetails {
  templateId?: string;
  currentRevision?: number;
}

export class DashboardBuilderError extends Error {
  readonly code: DashboardBuilderErrorCode;
  readonly details: DashboardBuilderErrorDetails | undefined;
  readonly retryable: boolean;

  constructor(
    code: DashboardBuilderErrorCode,
    message: string,
    options: {
      details?: DashboardBuilderErrorDetails;
      retryable?: boolean;
      cause?: unknown;
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DashboardBuilderError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}
