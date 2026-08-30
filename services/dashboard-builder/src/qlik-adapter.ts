import {
  DASHBOARD_MAX_PREVIEW_ROWS,
  DashboardPreviewRequestSchema,
  DashboardPreviewResponseSchema,
  type DashboardAdapterStatus,
  type DashboardDiagnostic,
  type DashboardManifest,
  type DashboardPreviewRequest,
  type DashboardPreviewResponse
} from "@unified-ai/contracts/dashboard-builder";
import { canonicalJson, sha256Hex } from "@unified-ai/evidence-index";
import type { DashboardDataAdapter } from "./data-adapter.js";
import { DashboardBuilderError } from "./errors.js";

type DashboardProjection = DashboardPreviewResponse["projections"][number];
type QlikSourceReference = NonNullable<
  DashboardManifest["provenance"]["sourceReference"]
>;

export type QlikProviderErrorCode =
  | "unavailable"
  | "unauthorized"
  | "binding"
  | "expression"
  | "unsupported"
  | "rate-limit";

export class QlikProviderError extends Error {
  readonly code: QlikProviderErrorCode;

  constructor(code: QlikProviderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "QlikProviderError";
    this.code = code;
  }
}

export interface QlikProviderPreviewRequest {
  source: QlikSourceReference;
  manifest: DashboardManifest;
  parameterValues: DashboardPreviewRequest["parameterValues"];
  filters: DashboardPreviewRequest["filters"];
  sort: DashboardPreviewRequest["sort"];
  page: DashboardPreviewRequest["page"];
}

export interface QlikProviderPreviewResult {
  projections: DashboardPreviewResponse["projections"];
  diagnostics: readonly QlikProviderErrorCode[];
}

export interface QlikPreviewProvider {
  preview(request: QlikProviderPreviewRequest): Promise<QlikProviderPreviewResult>;
}

export interface QlikDashboardAdapterOptions {
  enabled?: boolean;
  allowedAppIds?: readonly string[];
  maxRows?: number;
  provider?: QlikPreviewProvider;
  capabilities?: Partial<DashboardAdapterStatus["capabilities"]>;
  now?: () => Date;
}

const DISABLED_DIAGNOSTIC: DashboardDiagnostic = {
  severity: "info",
  code: "qlik-adapter-disabled",
  path: "/runtime/preferredAdapter",
  message: "The Qlik adapter is disabled until an authorized provider is configured.",
  remediation: "Inject an approved non-production Qlik provider and app allowlist."
};

const PROVIDER_UNAVAILABLE_DIAGNOSTIC: DashboardDiagnostic = {
  severity: "warning",
  code: "qlik-provider-unavailable",
  path: "/runtime/preferredAdapter",
  message: "The Qlik provider is unavailable.",
  remediation: "Check the approved provider configuration and retry later."
};

function providerDiagnostic(code: QlikProviderErrorCode): DashboardDiagnostic {
  if (code === "unauthorized") {
    return {
      severity: "error",
      code: "qlik-unauthorized",
      path: "/provenance/sourceReference/appId",
      message: "The Qlik provider did not authorize access to the requested app.",
      remediation: "Confirm the approved server-side Qlik identity and app access."
    };
  }
  if (code === "binding") {
    return {
      severity: "error",
      code: "qlik-binding-invalid",
      path: "/bindings",
      message: "One or more dashboard bindings cannot be resolved by the Qlik provider.",
      remediation: "Update the sanitized binding metadata for this Qlik app."
    };
  }
  if (code === "expression") {
    return {
      severity: "error",
      code: "qlik-expression-invalid",
      path: "/calculations",
      message: "One or more Qlik calculations were rejected by the provider.",
      remediation: "Correct the governed Qlik expression metadata and retry."
    };
  }
  if (code === "unsupported") {
    return {
      severity: "error",
      code: "qlik-operation-unsupported",
      path: "/components",
      message: "The Qlik provider does not support a requested dashboard operation.",
      remediation: "Use a supported component or provider capability."
    };
  }
  if (code === "rate-limit") {
    return {
      severity: "warning",
      code: "qlik-rate-limited",
      path: "/runtime/preferredAdapter",
      message: "The Qlik provider temporarily limited preview requests.",
      remediation: "Wait before retrying the preview request."
    };
  }
  return PROVIDER_UNAVAILABLE_DIAGNOSTIC;
}

function unavailableProjection(
  component: DashboardManifest["components"][number],
  diagnostic: DashboardDiagnostic,
  page: DashboardPreviewRequest["page"],
  maxRows: number
): DashboardProjection {
  const base = {
    componentId: component.componentId,
    title: component.title,
    status: "unavailable" as const,
    diagnostics: [diagnostic]
  };
  if (component.type === "kpi") {
    return { ...base, type: "kpi", value: null, formattedValue: "" };
  }
  if (component.type === "data-table") {
    return {
      ...base,
      type: "data-table",
      columns: component.columns.map((column) => ({
        columnId: column.columnId,
        header: column.header
      })),
      rows: [],
      totalRows: 0,
      offset: page.offset,
      limit: Math.min(page.limit, component.pageSize, maxRows)
    };
  }
  if (component.type === "bar-chart" || component.type === "line-chart") {
    return { ...base, type: component.type, series: [] };
  }
  if (component.type === "filter") {
    return { ...base, type: "filter", bindingId: component.bindingId, options: [] };
  }
  return { ...base, type: "text", text: "" };
}

function boundProjection(projection: DashboardProjection, maxRows: number): DashboardProjection {
  const diagnostics: DashboardDiagnostic[] = [];
  if (projection.type === "data-table") {
    return {
      ...projection,
      diagnostics,
      rows: projection.rows.slice(0, maxRows),
      limit: Math.min(projection.limit, maxRows)
    };
  }
  if (projection.type === "bar-chart" || projection.type === "line-chart") {
    return {
      ...projection,
      diagnostics,
      series: projection.series.map((series) => ({
        ...series,
        points: series.points.slice(0, maxRows)
      }))
    };
  }
  if (projection.type === "filter") {
    return { ...projection, diagnostics, options: projection.options.slice(0, maxRows) };
  }
  return { ...projection, diagnostics };
}

function projectionsMatchManifest(
  projections: readonly DashboardProjection[],
  manifest: DashboardManifest
): boolean {
  if (projections.length !== manifest.components.length) {
    return false;
  }
  const expected = new Map(
    manifest.components.map((component) => [component.componentId, component.type])
  );
  const seen = new Set<string>();
  return projections.every((projection) => {
    const expectedType = expected.get(projection.componentId);
    if (expectedType !== projection.type || seen.has(projection.componentId)) {
      return false;
    }
    seen.add(projection.componentId);
    return true;
  });
}

export class QlikDashboardAdapter implements DashboardDataAdapter {
  readonly adapterId = "qlik" as const;
  readonly #enabled: boolean;
  readonly #allowedAppIds: ReadonlySet<string>;
  readonly #maxRows: number;
  readonly #provider: QlikPreviewProvider | undefined;
  readonly #capabilities: DashboardAdapterStatus["capabilities"];
  readonly #now: () => Date;

  constructor(options: QlikDashboardAdapterOptions = {}) {
    const maxRows = options.maxRows ?? DASHBOARD_MAX_PREVIEW_ROWS;
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > DASHBOARD_MAX_PREVIEW_ROWS) {
      throw new TypeError(
        `Qlik maxRows must be an integer between 1 and ${String(DASHBOARD_MAX_PREVIEW_ROWS)}.`
      );
    }
    this.#enabled = options.enabled ?? false;
    this.#allowedAppIds = new Set(options.allowedAppIds ?? []);
    this.#maxRows = maxRows;
    this.#provider = options.provider;
    this.#now = options.now ?? (() => new Date());
    this.#capabilities = {
      portableCalculations: options.capabilities?.portableCalculations ?? false,
      qlikCalculations: options.capabilities?.qlikCalculations ?? true,
      selections: options.capabilities?.selections ?? false,
      paging: options.capabilities?.paging ?? true
    };
  }

  async status(): Promise<DashboardAdapterStatus> {
    if (!this.#enabled) {
      return {
        adapterId: this.adapterId,
        label: "Qlik governed adapter",
        status: "unavailable",
        capabilities: {
          portableCalculations: false,
          qlikCalculations: false,
          selections: false,
          paging: false
        },
        diagnostics: [DISABLED_DIAGNOSTIC]
      };
    }
    if (this.#provider === undefined || this.#allowedAppIds.size === 0) {
      return {
        adapterId: this.adapterId,
        label: "Qlik governed adapter",
        status: "unavailable",
        capabilities: {
          portableCalculations: false,
          qlikCalculations: false,
          selections: false,
          paging: false
        },
        diagnostics: [PROVIDER_UNAVAILABLE_DIAGNOSTIC]
      };
    }
    return {
      adapterId: this.adapterId,
      label: "Qlik governed adapter",
      status: "ready",
      capabilities: this.#capabilities,
      diagnostics: []
    };
  }

  #responseWithDiagnostic(
    request: DashboardPreviewRequest,
    diagnostic: DashboardDiagnostic
  ): DashboardPreviewResponse {
    const requestSha256 = sha256Hex(canonicalJson(request));
    return DashboardPreviewResponseSchema.parse({
      buildId: `qlik-preview-${requestSha256.slice(0, 16)}`,
      templateId: request.manifest.template.templateId,
      manifestSha256: sha256Hex(canonicalJson(request.manifest)),
      adapterId: this.adapterId,
      generatedAt: this.#now().toISOString(),
      projections: request.manifest.components.map((component) =>
        unavailableProjection(component, diagnostic, request.page, this.#maxRows)
      ),
      diagnostics: [diagnostic]
    });
  }

  async preview(input: DashboardPreviewRequest): Promise<DashboardPreviewResponse> {
    let request: DashboardPreviewRequest;
    try {
      request = DashboardPreviewRequestSchema.parse(input);
    } catch (error) {
      throw new DashboardBuilderError(
        "invalid-dashboard-request",
        "The Qlik preview request failed contract validation.",
        { cause: error }
      );
    }
    if (request.adapterId !== this.adapterId) {
      throw new DashboardBuilderError(
        "adapter-unavailable",
        "The Qlik adapter cannot handle the requested adapter identity."
      );
    }
    if (!this.#enabled) {
      return this.#responseWithDiagnostic(request, DISABLED_DIAGNOSTIC);
    }
    if (this.#provider === undefined) {
      return this.#responseWithDiagnostic(request, PROVIDER_UNAVAILABLE_DIAGNOSTIC);
    }
    const source = request.manifest.provenance.sourceReference;
    if (request.manifest.provenance.source !== "qlik-object-metadata" || source === null) {
      return this.#responseWithDiagnostic(request, {
        severity: "error",
        code: "qlik-source-reference-required",
        path: "/provenance/sourceReference",
        message: "Qlik preview requires a sanitized Qlik source reference.",
        remediation: "Provide governed tenant, app, and object identifiers."
      });
    }
    if (!this.#allowedAppIds.has(source.appId)) {
      return this.#responseWithDiagnostic(request, {
        severity: "error",
        code: "qlik-app-unauthorized",
        path: "/provenance/sourceReference/appId",
        message: "The requested Qlik app is not in the server-side allowlist.",
        remediation: "Ask an operator to approve this non-production Qlik app."
      });
    }

    try {
      const providerResult = await this.#provider.preview({
        source,
        manifest: request.manifest,
        parameterValues: request.parameterValues,
        filters: request.filters,
        sort: request.sort,
        page: {
          offset: request.page.offset,
          limit: Math.min(request.page.limit, this.#maxRows)
        }
      });
      if (!projectionsMatchManifest(providerResult.projections, request.manifest)) {
        throw new QlikProviderError(
          "unavailable",
          "Qlik provider projections did not match the requested manifest."
        );
      }
      const requestSha256 = sha256Hex(canonicalJson(request));
      return DashboardPreviewResponseSchema.parse({
        buildId: `qlik-preview-${requestSha256.slice(0, 16)}`,
        templateId: request.manifest.template.templateId,
        manifestSha256: sha256Hex(canonicalJson(request.manifest)),
        adapterId: this.adapterId,
        generatedAt: this.#now().toISOString(),
        projections: providerResult.projections.map((projection) =>
          boundProjection(projection, this.#maxRows)
        ),
        diagnostics: [...new Set(providerResult.diagnostics)]
          .slice(0, 1_000)
          .map(providerDiagnostic)
      });
    } catch (error) {
      const diagnostic =
        error instanceof QlikProviderError
          ? providerDiagnostic(error.code)
          : PROVIDER_UNAVAILABLE_DIAGNOSTIC;
      return this.#responseWithDiagnostic(request, diagnostic);
    }
  }
}
