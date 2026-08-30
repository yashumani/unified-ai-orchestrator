import {
  DASHBOARD_MAX_UPLOAD_BYTES,
  DashboardAdaptersResponseSchema,
  DashboardBuildReceiptSchema,
  DashboardDraftUpdateResponseSchema,
  DashboardImportResponseSchema,
  DashboardManifestSchema,
  DashboardPreviewRequestSchema,
  DashboardPreviewResponseSchema,
  DashboardPublishResponseSchema,
  DashboardRevisionListResponseSchema,
  DashboardRevisionResponseSchema,
  DashboardRollbackResponseSchema,
  DashboardTemplateListResponseSchema,
  DashboardTemplateResponseSchema,
  DashboardValidationResultSchema,
  type DashboardManifest
} from "@unified-ai/contracts/dashboard-builder";
import { DashboardBuilderError } from "@unified-ai/dashboard-builder";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve, sep } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { OrchestratorConfig } from "./config.js";
import type { OrchestratorServices } from "./composition.js";
import type {
  DashboardBuilderRouteContext,
  DashboardBuilderRouteService
} from "./dashboard-builder-routes.js";

const servers: Server[] = [];
let sampleBytes: Buffer;
let sampleManifest: DashboardManifest;
const repositoryRoot = process.cwd().endsWith(`${sep}apps${sep}api`)
  ? resolve(process.cwd(), "..", "..")
  : process.cwd();

const config: OrchestratorConfig = {
  host: "127.0.0.1",
  port: 8790,
  repositoryRoot,
  releasePayloadRoot: repositoryRoot,
  evidenceRoot: resolve(repositoryRoot, ".local", "evidence"),
  trustGrantRelativePath: ".local/trust/workspace-grant.json",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  ollamaExecutable: "C:\\Tools\\Ollama\\ollama.exe",
  whiteshadowBaseUrl: "http://127.0.0.1:8787",
  whiteshadowWorkspace: "D:\\whiteshadow-workspace\\local-llm-ws",
  whiteshadowPython: "D:\\whiteshadow-workspace\\local-llm-ws\\.venv\\Scripts\\python.exe",
  webDistRoot: resolve(repositoryRoot, "apps", "web", "dist")
};

beforeAll(async () => {
  sampleBytes = await readFile(
    resolve(
      repositoryRoot,
      "sources",
      "fixtures",
      "dashboard-builder",
      "sales-overview.manifest.json"
    )
  );
  sampleManifest = DashboardManifestSchema.parse(
    JSON.parse(sampleBytes.toString("utf8")) as unknown
  );
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => server.close(() => done()))
    )
  );
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function templateSummary(currentRevision = 0, activeRevisionNumber: number | null = null) {
  return {
    templateId: sampleManifest.template.templateId,
    name: sampleManifest.template.name,
    currentRevision,
    activeRevisionNumber,
    manifestSha256: "a".repeat(64),
    integrity: "verified" as const
  };
}

function validation(valid = true, publishEligible = true) {
  return DashboardValidationResultSchema.parse({
    schemaVersion: "dashboard-validation/v1",
    valid,
    publishEligible,
    normalizedManifest: valid ? sampleManifest : null,
    manifestSha256: valid ? "a".repeat(64) : null,
    diagnostics: valid
      ? []
      : [
          {
            severity: "error",
            code: "duplicate-binding-id",
            path: "/bindings/1/bindingId",
            message: "Binding identifiers must be unique."
          }
        ]
  });
}

function buildReceipt() {
  return DashboardBuildReceiptSchema.parse({
    schemaVersion: "dashboard-build-receipt/v1",
    buildId: "dashboard-build-fixture",
    templateId: sampleManifest.template.templateId,
    draftRevision: 1,
    adapterId: "fixture",
    status: "succeeded",
    startedAt: "2026-08-29T12:00:00.000Z",
    completedAt: "2026-08-29T12:00:00.000Z",
    manifestSha256: "a".repeat(64),
    validationObjectSha256: "b".repeat(64),
    componentCount: sampleManifest.components.length,
    rowCount: 4,
    diagnosticCodes: []
  });
}

function revisionSummary(revisionNumber = 1, eventType: "published" | "rollback" = "published") {
  return {
    templateId: sampleManifest.template.templateId,
    revisionNumber,
    eventId: `dashboard-event-${String(revisionNumber)}`,
    eventType,
    sourceRevisionNumber: eventType === "rollback" ? 1 : null,
    manifestSha256: "a".repeat(64),
    actor: "local-operator",
    occurredAt: "2026-08-29T12:00:00.000Z",
    buildId: "dashboard-build-fixture"
  };
}

function previewResponse() {
  const request = DashboardPreviewRequestSchema.parse({
    manifest: sampleManifest,
    adapterId: "fixture",
    parameterValues: { "minimum-sales": 0 },
    filters: [],
    sort: [],
    page: { offset: 0, limit: 25 }
  });
  return DashboardPreviewResponseSchema.parse({
    buildId: "dashboard-build-fixture",
    templateId: sampleManifest.template.templateId,
    manifestSha256: "a".repeat(64),
    adapterId: "fixture",
    generatedAt: "2026-08-29T12:00:00.000Z",
    projections: request.manifest.components.map((component) => {
      const base = {
        componentId: component.componentId,
        title: component.title,
        status: "ready" as const,
        diagnostics: []
      };
      if (component.type === "kpi") {
        return { ...base, type: "kpi" as const, value: 1, formattedValue: "$1" };
      }
      if (component.type === "data-table") {
        return {
          ...base,
          type: "data-table" as const,
          columns: component.columns.map((column) => ({
            columnId: column.columnId,
            header: column.header
          })),
          rows: [],
          totalRows: 0,
          offset: 0,
          limit: 25
        };
      }
      if (component.type === "bar-chart" || component.type === "line-chart") {
        return { ...base, type: component.type, series: [] };
      }
      if (component.type === "filter") {
        return {
          ...base,
          type: "filter" as const,
          bindingId: component.bindingId,
          options: []
        };
      }
      return { ...base, type: "text" as const, text: component.text };
    }),
    diagnostics: []
  });
}

function dashboardService(
  overrides: Partial<DashboardBuilderRouteService> = {}
): DashboardBuilderRouteService {
  const receipt = buildReceipt();
  const revision = revisionSummary();
  return {
    listTemplates: vi.fn(() =>
      DashboardTemplateListResponseSchema.parse({ items: [templateSummary()] })
    ),
    getTemplate: vi.fn(() =>
      DashboardTemplateResponseSchema.parse({
        template: templateSummary(),
        manifest: sampleManifest,
        validation: validation()
      })
    ),
    listRevisions: vi.fn(() =>
      DashboardRevisionListResponseSchema.parse({ items: [revision] })
    ),
    getRevision: vi.fn(() =>
      DashboardRevisionResponseSchema.parse({ revision, manifest: sampleManifest })
    ),
    getBuild: vi.fn(async () => receipt),
    listAdapterStatuses: vi.fn(async () =>
      DashboardAdaptersResponseSchema.parse({
        items: [
          {
            adapterId: "fixture",
            label: "Tracked synthetic fixture",
            status: "ready",
            capabilities: {
              portableCalculations: true,
              qlikCalculations: false,
              selections: true,
              paging: true
            },
            diagnostics: []
          },
          {
            adapterId: "qlik",
            label: "Qlik governed adapter",
            status: "unavailable",
            capabilities: {
              portableCalculations: false,
              qlikCalculations: false,
              selections: false,
              paging: false
            },
            diagnostics: [
              {
                severity: "info",
                code: "qlik-adapter-disabled",
                path: "/runtime/preferredAdapter",
                message: "The Qlik adapter is disabled."
              }
            ]
          }
        ]
      }).items
    ),
    validate: vi.fn(() => validation()),
    importManifest: vi.fn(async (bytes: Uint8Array) =>
      DashboardImportResponseSchema.parse({
        template: templateSummary(),
        receipt: {
          schemaVersion: "dashboard-import-receipt/v1",
          importId: "dashboard-import-fixture",
          templateId: sampleManifest.template.templateId,
          actor: "local-operator",
          occurredAt: "2026-08-29T12:00:00.000Z",
          uploadBytes: bytes.byteLength,
          originalUploadSha256: sha256(bytes),
          normalizedManifestSha256: "a".repeat(64),
          diagnosticCodes: []
        },
        diagnostics: []
      })
    ),
    updateDraft: vi.fn(async () =>
      DashboardDraftUpdateResponseSchema.parse({
        template: templateSummary(1),
        manifest: sampleManifest,
        validation: validation()
      })
    ),
    preview: vi.fn(async () => previewResponse()),
    publish: vi.fn(async () =>
      DashboardPublishResponseSchema.parse({
        template: templateSummary(2, 1),
        revision,
        receipt,
        idempotent: false
      })
    ),
    rollback: vi.fn(async () =>
      DashboardRollbackResponseSchema.parse({
        template: templateSummary(3, 2),
        revision: revisionSummary(2, "rollback"),
        receipt
      })
    ),
    ...overrides
  };
}

function routeContext(
  service: DashboardBuilderRouteService = dashboardService()
): DashboardBuilderRouteContext {
  return {
    service,
    sample: { manifest: sampleManifest, manifestBytes: sampleBytes }
  };
}

function services(context: DashboardBuilderRouteContext): OrchestratorServices {
  return {
    config,
    dashboardBuilder: context,
    runtime: {},
    policy: {},
    whiteshadow: {},
    evidence: {},
    portfolio: {},
    agent: {},
    ollama: {},
    repositoryTools: {},
    tools: {}
  } as unknown as OrchestratorServices;
}

async function startLocal(context: DashboardBuilderRouteContext): Promise<string> {
  const app = await createApp({
    config,
    services: services(context),
    mountCopilotRuntime: false,
    serveWeb: false
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((done, reject) => {
    server.once("listening", done);
    server.once("error", reject);
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function jsonRequest(
  url: string,
  method: "POST" | "PUT",
  body: unknown
): Promise<Response> {
  return fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("dashboard builder loopback routes", () => {
  it("preserves sample and import bytes while exposing the gallery", async () => {
    const service = dashboardService();
    const baseUrl = await startLocal(routeContext(service));

    const sample = await fetch(`${baseUrl}/api/dashboard-builder/sample`);
    expect(sample.status).toBe(200);
    expect(sample.headers.get("content-type")).toContain("application/json");
    expect(sample.headers.get("content-disposition")).toContain(
      "sales-overview.dashboard.json"
    );
    expect(await sample.text()).toBe(sampleBytes.toString("utf8"));

    const imported = await fetch(`${baseUrl}/api/dashboard-builder/imports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: sampleBytes
    });
    expect(imported.status).toBe(201);
    const importBody = DashboardImportResponseSchema.parse(await imported.json());
    expect(importBody.receipt.originalUploadSha256).toBe(sha256(sampleBytes));
    expect(service.importManifest).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "local-operator"
    );
    expect(
      Buffer.from(
        (service.importManifest as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Uint8Array
      )
    ).toEqual(sampleBytes);

    const gallery = await fetch(`${baseUrl}/api/dashboard-builder/templates`);
    expect(gallery.status).toBe(200);
    expect(DashboardTemplateListResponseSchema.parse(await gallery.json()).items).toHaveLength(1);

    const detail = await fetch(
      `${baseUrl}/api/dashboard-builder/templates/sales-overview`
    );
    expect(detail.status).toBe(200);
    expect(DashboardTemplateResponseSchema.parse(await detail.json()).manifest).toEqual(
      sampleManifest
    );
  });

  it("validates response contracts through draft, preview, publish, download, build, and rollback", async () => {
    const service = dashboardService();
    const baseUrl = await startLocal(routeContext(service));
    const templateUrl = `${baseUrl}/api/dashboard-builder/templates/sales-overview`;

    const draft = await jsonRequest(`${templateUrl}/draft`, "PUT", {
      expectedRevision: 0,
      actor: "local-operator",
      manifest: sampleManifest
    });
    expect(draft.status).toBe(200);
    DashboardDraftUpdateResponseSchema.parse(await draft.json());

    const checked = await jsonRequest(`${templateUrl}/validate`, "POST", {
      manifest: sampleManifest,
      mode: "publish"
    });
    expect(checked.status).toBe(200);
    DashboardValidationResultSchema.parse(await checked.json());

    const previewRequest = {
      manifest: sampleManifest,
      adapterId: "fixture",
      parameterValues: { "minimum-sales": 0 },
      filters: [],
      sort: [],
      page: { offset: 0, limit: 25 }
    };
    const preview = await jsonRequest(`${templateUrl}/preview`, "POST", previewRequest);
    expect(preview.status).toBe(200);
    DashboardPreviewResponseSchema.parse(await preview.json());

    const published = await jsonRequest(`${templateUrl}/publish`, "POST", {
      expectedRevision: 1,
      actor: "local-operator"
    });
    expect(published.status).toBe(201);
    DashboardPublishResponseSchema.parse(await published.json());

    const revisions = await fetch(`${templateUrl}/revisions`);
    expect(revisions.status).toBe(200);
    DashboardRevisionListResponseSchema.parse(await revisions.json());

    const revision = await fetch(`${templateUrl}/revisions/1`);
    expect(revision.status).toBe(200);
    expect(revision.headers.get("content-disposition")).toContain(
      "sales-overview.revision-1.dashboard.json"
    );
    DashboardRevisionResponseSchema.parse(await revision.json());

    const build = await fetch(
      `${baseUrl}/api/dashboard-builder/builds/dashboard-build-fixture`
    );
    expect(build.status).toBe(200);
    DashboardBuildReceiptSchema.parse(await build.json());

    const rolledBack = await jsonRequest(`${templateUrl}/rollback`, "POST", {
      expectedRevision: 2,
      targetRevisionNumber: 1,
      actor: "local-operator"
    });
    expect(rolledBack.status).toBe(201);
    DashboardRollbackResponseSchema.parse(await rolledBack.json());
  });

  it("returns 422 for semantic validation and 503 before invoking an unavailable adapter", async () => {
    const invalid = validation(false, false);
    const service = dashboardService({ validate: vi.fn(() => invalid) });
    const baseUrl = await startLocal(routeContext(service));
    const templateUrl = `${baseUrl}/api/dashboard-builder/templates/sales-overview`;

    const checked = await jsonRequest(`${templateUrl}/validate`, "POST", {
      manifest: sampleManifest,
      mode: "draft"
    });
    expect(checked.status).toBe(422);
    expect(DashboardValidationResultSchema.parse(await checked.json())).toEqual(invalid);

    const qlikPreview = await jsonRequest(`${templateUrl}/preview`, "POST", {
      manifest: sampleManifest,
      adapterId: "qlik",
      parameterValues: { "minimum-sales": 0 },
      filters: [],
      sort: [],
      page: { offset: 0, limit: 25 }
    });
    expect(qlikPreview.status).toBe(503);
    expect(await qlikPreview.json()).toEqual({
      error: {
        code: "adapter-unavailable",
        message: "The requested dashboard adapter is unavailable.",
        retryable: true,
        details: null
      }
    });
    expect(service.preview).not.toHaveBeenCalled();

    const adapters = await fetch(`${baseUrl}/api/dashboard-builder/adapters`);
    expect(adapters.status).toBe(200);
    expect(DashboardAdaptersResponseSchema.parse(await adapters.json()).items).toHaveLength(2);
  });

  it("enforces the loopback JSON and upload-size boundary", async () => {
    const service = dashboardService();
    const baseUrl = await startLocal(routeContext(service));
    const importsUrl = `${baseUrl}/api/dashboard-builder/imports`;

    const hostile = await fetch(importsUrl, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json"
      },
      body: sampleBytes
    });
    expect(hostile.status).toBe(403);

    const wrongType = await fetch(importsUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: sampleBytes
    });
    expect(wrongType.status).toBe(415);

    const oversized = await fetch(importsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.alloc(DASHBOARD_MAX_UPLOAD_BYTES + 1, 0x20)
    });
    expect(oversized.status).toBe(413);
    expect(service.importManifest).not.toHaveBeenCalled();
  });

  it("returns bounded conflict and integrity errors without leaking manifests or causes", async () => {
    const conflictService = dashboardService({
      updateDraft: vi.fn(async () => {
        throw new DashboardBuilderError("revision-conflict", "secret stale body", {
          details: { templateId: "sales-overview", currentRevision: 7 }
        });
      }),
      getTemplate: vi.fn(() => {
        throw new DashboardBuilderError(
          "evidence-integrity-failed",
          "raw manifest secret: must-not-escape",
          { cause: new Error("filesystem secret") }
        );
      })
    });
    const baseUrl = await startLocal(routeContext(conflictService));
    const templateUrl = `${baseUrl}/api/dashboard-builder/templates/sales-overview`;

    const conflict = await jsonRequest(`${templateUrl}/draft`, "PUT", {
      expectedRevision: 0,
      actor: "local-operator",
      manifest: sampleManifest
    });
    expect(conflict.status).toBe(409);
    const conflictText = await conflict.text();
    expect(conflictText).not.toContain("secret stale body");
    expect(JSON.parse(conflictText)).toEqual({
      error: {
        code: "revision-conflict",
        message: "The dashboard draft changed before this request completed.",
        retryable: false,
        details: { templateId: "sales-overview", currentRevision: 7 }
      }
    });

    const integrity = await fetch(templateUrl);
    expect(integrity.status).toBe(500);
    const integrityText = await integrity.text();
    expect(integrityText).not.toMatch(/must-not-escape|filesystem secret|raw manifest/iu);
    expect(JSON.parse(integrityText)).toEqual({
      error: {
        code: "evidence-integrity-failed",
        message: "Dashboard evidence failed integrity verification.",
        retryable: false,
        details: null
      }
    });

    const encodedInvalidId = await fetch(
      `${baseUrl}/api/dashboard-builder/templates/sales-overview%2Fprivate`
    );
    expect(encodedInvalidId.status).toBe(400);
    expect(await encodedInvalidId.text()).not.toContain("private");
  });

  it("maps missing records, malformed JSON, and invalid service responses safely", async () => {
    const service = dashboardService({
      getBuild: vi.fn(async () => {
        throw new DashboardBuilderError(
          "template-not-found",
          "secret missing path"
        );
      }),
      listTemplates: vi.fn(() => ({ items: [{ rawManifest: "must-not-escape" }] })) as
        unknown as DashboardBuilderRouteService["listTemplates"]
    });
    const baseUrl = await startLocal(routeContext(service));

    const missing = await fetch(
      `${baseUrl}/api/dashboard-builder/builds/missing-build`
    );
    expect(missing.status).toBe(404);
    const missingText = await missing.text();
    expect(missingText).not.toContain("secret missing path");
    expect(JSON.parse(missingText)).toEqual({
      error: {
        code: "invalid_request",
        message: "The requested dashboard record was not found.",
        retryable: false
      }
    });

    const malformed = await fetch(
      `${baseUrl}/api/dashboard-builder/templates/sales-overview/publish`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json"
      }
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "The request contains invalid JSON or encoding.",
        retryable: false
      }
    });

    const invalidResponse = await fetch(
      `${baseUrl}/api/dashboard-builder/templates`
    );
    expect(invalidResponse.status).toBe(500);
    const invalidResponseText = await invalidResponse.text();
    expect(invalidResponseText).not.toContain("must-not-escape");
    expect(JSON.parse(invalidResponseText)).toEqual({
      error: {
        code: "evidence-integrity-failed",
        message: "Dashboard evidence failed integrity verification.",
        retryable: false,
        details: null
      }
    });
  });
});
