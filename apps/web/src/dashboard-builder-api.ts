import {
  DASHBOARD_MAX_UPLOAD_BYTES,
  DashboardAdaptersResponseSchema,
  DashboardBuildReceiptSchema,
  DashboardDraftUpdateRequestSchema,
  DashboardDraftUpdateResponseSchema,
  DashboardImportResponseSchema,
  DashboardManifestSchema,
  DashboardPreviewRequestSchema,
  DashboardPreviewResponseSchema,
  DashboardPublishRequestSchema,
  DashboardPublishResponseSchema,
  DashboardRevisionListResponseSchema,
  DashboardRevisionResponseSchema,
  DashboardRollbackRequestSchema,
  DashboardRollbackResponseSchema,
  DashboardTemplateListResponseSchema,
  DashboardTemplateResponseSchema,
  DashboardValidateRequestSchema,
  DashboardValidationResultSchema,
  type DashboardAdaptersResponse,
  type DashboardBuildReceipt,
  type DashboardDraftUpdateRequest,
  type DashboardDraftUpdateResponse,
  type DashboardImportResponse,
  type DashboardManifest,
  type DashboardPreviewRequest,
  type DashboardPreviewResponse,
  type DashboardPublishRequest,
  type DashboardPublishResponse,
  type DashboardRevisionListResponse,
  type DashboardRevisionResponse,
  type DashboardRollbackRequest,
  type DashboardRollbackResponse,
  type DashboardTemplateListResponse,
  type DashboardTemplateResponse,
  type DashboardValidateRequest,
  type DashboardValidationResult
} from "@unified-ai/contracts/dashboard-builder";

interface RuntimeSchema<T> {
  parse(input: unknown): T;
}

export interface DashboardManifestDownload {
  fileName: string;
  json: string;
  manifest: DashboardManifest;
}

export interface DashboardBuilderConflictDetails {
  templateId: string;
  currentRevision: number;
}

export class DashboardBuilderApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly details: DashboardBuilderConflictDetails | null;

  constructor(options: {
    message: string;
    status: number;
    code?: string;
    retryable?: boolean;
    details?: DashboardBuilderConflictDetails | null;
  }) {
    super(options.message);
    this.name = "DashboardBuilderApiError";
    this.status = options.status;
    this.code = options.code ?? "dashboard-request-failed";
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseErrorEnvelope(value: unknown): {
  code?: string;
  message?: string;
  retryable?: boolean;
  details?: DashboardBuilderConflictDetails | null;
} {
  const envelope = asRecord(value);
  const error = asRecord(envelope?.error);
  const details = asRecord(error?.details);
  const parsedDetails =
    typeof details?.templateId === "string" &&
    typeof details.currentRevision === "number" &&
    Number.isInteger(details.currentRevision)
      ? {
          templateId: details.templateId,
          currentRevision: details.currentRevision
        }
      : null;
  return {
    ...(typeof error?.code === "string" ? { code: error.code.slice(0, 128) } : {}),
    ...(typeof error?.message === "string"
      ? { message: error.message.slice(0, 500) }
      : {}),
    ...(typeof error?.retryable === "boolean"
      ? { retryable: error.retryable }
      : {}),
    ...(error?.details === null || parsedDetails !== null
      ? { details: parsedDetails }
      : {})
  };
}

async function throwResponseError(response: Response): Promise<never> {
  let error: ReturnType<typeof parseErrorEnvelope> = {};
  try {
    error = parseErrorEnvelope(await response.json());
  } catch {
    // Raw upstream or parser details are intentionally discarded.
  }
  throw new DashboardBuilderApiError({
    status: response.status,
    message:
      error.message ?? `The local dashboard API returned HTTP ${String(response.status)}.`,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.details === undefined ? {} : { details: error.details })
  });
}

async function requestText(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT";
    body?: string;
    signal?: AbortSignal;
    acceptedStatuses?: readonly number[];
  } = {}
): Promise<string> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(options.body === undefined ? {} : { body: options.body }),
    credentials: "omit",
    cache: "no-store",
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  if (
    !response.ok &&
    !(options.acceptedStatuses ?? []).includes(response.status)
  ) {
    return throwResponseError(response);
  }
  return response.text();
}

async function requestJson<T>(
  path: string,
  schema: RuntimeSchema<T>,
  options: {
    method?: "GET" | "POST" | "PUT";
    body?: unknown;
    rawBody?: string;
    signal?: AbortSignal;
    acceptedStatuses?: readonly number[];
  } = {}
): Promise<T> {
  let text: string;
  try {
    text = await requestText(path, {
      ...(options.method === undefined ? {} : { method: options.method }),
      ...(options.rawBody === undefined && options.body === undefined
        ? {}
        : {
            body:
              options.rawBody ?? JSON.stringify(options.body)
          }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.acceptedStatuses === undefined
        ? {}
        : { acceptedStatuses: options.acceptedStatuses })
    });
  } catch (error) {
    if (error instanceof DashboardBuilderApiError || error instanceof DOMException) {
      throw error;
    }
    throw new DashboardBuilderApiError({
      status: 0,
      code: "dashboard-network-failed",
      retryable: true,
      message: "The local dashboard API could not be reached."
    });
  }
  try {
    return schema.parse(JSON.parse(text) as unknown);
  } catch {
    throw new DashboardBuilderApiError({
      status: 502,
      code: "dashboard-response-invalid",
      message: "The local dashboard API returned an invalid response."
    });
  }
}

function templatePath(templateId: string): string {
  return `/api/dashboard-builder/templates/${encodeURIComponent(templateId)}`;
}

export async function downloadDashboardSample(
  signal?: AbortSignal
): Promise<DashboardManifestDownload> {
  const json = await requestText("/api/dashboard-builder/sample", {
    ...(signal === undefined ? {} : { signal })
  });
  try {
    const manifest = DashboardManifestSchema.parse(JSON.parse(json) as unknown);
    return {
      fileName: `${manifest.template.templateId}.dashboard.json`,
      json,
      manifest
    };
  } catch {
    throw new DashboardBuilderApiError({
      status: 502,
      code: "dashboard-response-invalid",
      message: "The tracked dashboard sample failed response validation."
    });
  }
}

export function importDashboardManifest(rawJson: string): Promise<DashboardImportResponse> {
  const bytes = new TextEncoder().encode(rawJson).byteLength;
  if (bytes < 1 || bytes > DASHBOARD_MAX_UPLOAD_BYTES) {
    return Promise.reject(
      new DashboardBuilderApiError({
        status: 413,
        code: "dashboard-upload-too-large",
        message: "Choose a non-empty JSON file no larger than 1 MiB."
      })
    );
  }
  return requestJson(
    "/api/dashboard-builder/imports",
    DashboardImportResponseSchema,
    { method: "POST", rawBody: rawJson }
  );
}

export function listDashboardTemplates(
  signal?: AbortSignal
): Promise<DashboardTemplateListResponse> {
  return requestJson(
    "/api/dashboard-builder/templates",
    DashboardTemplateListResponseSchema,
    { ...(signal === undefined ? {} : { signal }) }
  );
}

export function getDashboardTemplate(
  templateId: string,
  signal?: AbortSignal
): Promise<DashboardTemplateResponse> {
  return requestJson(templatePath(templateId), DashboardTemplateResponseSchema, {
    ...(signal === undefined ? {} : { signal })
  });
}

export function updateDashboardDraft(
  templateId: string,
  request: DashboardDraftUpdateRequest
): Promise<DashboardDraftUpdateResponse> {
  const body = DashboardDraftUpdateRequestSchema.parse(request);
  return requestJson(
    `${templatePath(templateId)}/draft`,
    DashboardDraftUpdateResponseSchema,
    { method: "PUT", body }
  );
}

export function validateDashboardDraft(
  templateId: string,
  request: DashboardValidateRequest,
  signal?: AbortSignal
): Promise<DashboardValidationResult> {
  const body = DashboardValidateRequestSchema.parse(request);
  return requestJson(
    `${templatePath(templateId)}/validate`,
    DashboardValidationResultSchema,
    {
      method: "POST",
      body,
      acceptedStatuses: [422],
      ...(signal === undefined ? {} : { signal })
    }
  );
}

export function previewDashboard(
  templateId: string,
  request: DashboardPreviewRequest,
  signal?: AbortSignal
): Promise<DashboardPreviewResponse> {
  const body = DashboardPreviewRequestSchema.parse(request);
  return requestJson(
    `${templatePath(templateId)}/preview`,
    DashboardPreviewResponseSchema,
    {
      method: "POST",
      body,
      ...(signal === undefined ? {} : { signal })
    }
  );
}

export function publishDashboard(
  templateId: string,
  request: DashboardPublishRequest
): Promise<DashboardPublishResponse> {
  const body = DashboardPublishRequestSchema.parse(request);
  return requestJson(
    `${templatePath(templateId)}/publish`,
    DashboardPublishResponseSchema,
    { method: "POST", body }
  );
}

export function rollbackDashboard(
  templateId: string,
  request: DashboardRollbackRequest
): Promise<DashboardRollbackResponse> {
  const body = DashboardRollbackRequestSchema.parse(request);
  return requestJson(
    `${templatePath(templateId)}/rollback`,
    DashboardRollbackResponseSchema,
    { method: "POST", body }
  );
}

export function listDashboardRevisions(
  templateId: string,
  signal?: AbortSignal
): Promise<DashboardRevisionListResponse> {
  return requestJson(
    `${templatePath(templateId)}/revisions`,
    DashboardRevisionListResponseSchema,
    { ...(signal === undefined ? {} : { signal }) }
  );
}

export async function downloadDashboardRevision(
  templateId: string,
  revisionNumber: number,
  signal?: AbortSignal
): Promise<DashboardManifestDownload> {
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
    throw new DashboardBuilderApiError({
      status: 400,
      code: "invalid-dashboard-request",
      message: "Choose a valid dashboard revision to download."
    });
  }
  const json = await requestText(
    `${templatePath(templateId)}/revisions/${String(revisionNumber)}`,
    { ...(signal === undefined ? {} : { signal }) }
  );
  try {
    const parsed = DashboardRevisionResponseSchema.parse(JSON.parse(json) as unknown);
    return {
      fileName: `${parsed.manifest.template.templateId}.revision-${String(revisionNumber)}.dashboard.json`,
      json: `${JSON.stringify(parsed.manifest, null, 2)}\n`,
      manifest: parsed.manifest
    };
  } catch {
    throw new DashboardBuilderApiError({
      status: 502,
      code: "dashboard-response-invalid",
      message: "The dashboard revision failed response validation."
    });
  }
}

export function getDashboardBuild(
  buildId: string,
  signal?: AbortSignal
): Promise<DashboardBuildReceipt> {
  return requestJson(
    `/api/dashboard-builder/builds/${encodeURIComponent(buildId)}`,
    DashboardBuildReceiptSchema,
    { ...(signal === undefined ? {} : { signal }) }
  );
}

export function listDashboardAdapters(
  signal?: AbortSignal
): Promise<DashboardAdaptersResponse> {
  return requestJson(
    "/api/dashboard-builder/adapters",
    DashboardAdaptersResponseSchema,
    { ...(signal === undefined ? {} : { signal }) }
  );
}
