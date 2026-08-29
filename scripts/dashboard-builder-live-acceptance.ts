import {
  DashboardAdaptersResponseSchema,
  DashboardBuildReceiptSchema,
  DashboardDraftUpdateResponseSchema,
  DashboardErrorEnvelopeSchema,
  DashboardImportResponseSchema,
  DashboardManifestSchema,
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
import {
  DashboardAdapterRegistry,
  DashboardService,
  FixtureDashboardAdapter,
  QlikDashboardAdapter,
  loadDashboardSample
} from "@unified-ai/dashboard-builder";
import {
  LocalEvidenceStore,
  canonicalJson,
  sha256Hex
} from "@unified-ai/evidence-index";
import { createApp } from "../apps/api/src/app.js";
import type { OrchestratorServices } from "../apps/api/src/composition.js";
import type { OrchestratorConfig } from "../apps/api/src/config.js";
import type { DashboardBuilderRouteContext } from "../apps/api/src/dashboard-builder-routes.js";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPORT_SCHEMA_VERSION = "dashboard-builder-local-acceptance/v1";
const FIXED_TIME = "2026-08-29T18:00:00.000Z";
const TEMPORARY_ROOT_PREFIX = "dashboard-builder-acceptance-";
const MAX_REPORT_BYTES = 16_384;

export type DashboardAcceptanceCheckCode =
  | "tracked-sample-roundtrip"
  | "manifest-validation"
  | "fixture-preview-and-build"
  | "draft-save-and-stale-conflict"
  | "immutable-revision-download"
  | "rollback"
  | "persistence-replay"
  | "malicious-manifest-rejection"
  | "qlik-disabled";

type DashboardAcceptanceFailureCode =
  | DashboardAcceptanceCheckCode
  | "temporary-root-invalid"
  | "api-start-failed"
  | "api-request-failed"
  | "api-shutdown-failed"
  | "temporary-cleanup-failed"
  | "report-safety-failed"
  | "explicit-local-opt-in-required";

export interface DashboardAcceptanceCheck {
  code: DashboardAcceptanceCheckCode;
  passed: true;
}

export interface SanitizedDashboardAcceptanceReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  accepted: true;
  runFingerprintSha256: string;
  boundary: {
    mode: "tracked-fixture";
    transport: "ephemeral-loopback";
    qlik: "disabled";
    evidence: "temporary-cleaned";
  };
  artifact: {
    sampleBytes: number;
    sampleSha256: string;
    normalizedManifestSha256: string;
  };
  lifecycle: {
    templateCount: number;
    componentProjectionCount: number;
    successfulBuildCount: number;
    staleConflictCount: number;
    publishedRevisionCount: number;
    rollbackRevisionCount: number;
    recoveredRevisionCount: number;
    rejectedMaliciousUploadCount: number;
    finalCurrentRevision: number;
    activeRevisionNumber: number;
    previewBuildFingerprintSha256: string;
  };
  checks: DashboardAcceptanceCheck[];
}

interface AcceptanceObservation {
  sampleBytes: number;
  sampleSha256: string;
  normalizedManifestSha256: string;
  componentProjectionCount: number;
  previewBuildFingerprintSha256: string;
  templateCount: number;
  successfulBuildCount: number;
  staleConflictCount: number;
  publishedRevisionCount: number;
  rollbackRevisionCount: number;
  recoveredRevisionCount: number;
  rejectedMaliciousUploadCount: number;
  finalCurrentRevision: number;
  activeRevisionNumber: number;
}

interface ActiveDashboardRuntime {
  baseUrl: string;
  close(): Promise<void>;
}

interface RuntimeSchema<T> {
  parse(input: unknown): T;
}

const SAFE_FAILURE_MESSAGES: Record<DashboardAcceptanceFailureCode, string> = {
  "tracked-sample-roundtrip": "The tracked sample did not round-trip through the local API.",
  "manifest-validation": "The governed manifest did not pass draft and publish validation.",
  "fixture-preview-and-build": "The fixture preview or its persisted build receipt was invalid.",
  "draft-save-and-stale-conflict": "Draft persistence or optimistic-concurrency enforcement failed.",
  "immutable-revision-download": "Published revision retrieval was not immutable or downloadable.",
  rollback: "The immutable rollback lifecycle did not restore the selected revision.",
  "persistence-replay": "A fresh service instance could not replay the persisted lifecycle.",
  "malicious-manifest-rejection": "An executable-content manifest was not rejected safely.",
  "qlik-disabled": "The local acceptance boundary did not keep Qlik disabled.",
  "temporary-root-invalid": "The temporary evidence path failed its repository boundary check.",
  "api-start-failed": "The ephemeral loopback API could not be started.",
  "api-request-failed": "A local acceptance request failed its bounded response contract.",
  "api-shutdown-failed": "The ephemeral loopback API could not be stopped cleanly.",
  "temporary-cleanup-failed": "The temporary evidence directory could not be removed safely.",
  "report-safety-failed": "The acceptance summary failed its sanitization boundary.",
  "explicit-local-opt-in-required": "The exact --local argument is required."
};

export class DashboardAcceptanceFailure extends Error {
  readonly code: DashboardAcceptanceFailureCode;

  constructor(code: DashboardAcceptanceFailureCode, options?: { cause?: unknown }) {
    super(
      SAFE_FAILURE_MESSAGES[code],
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "DashboardAcceptanceFailure";
    this.code = code;
  }
}

function fail(
  code: DashboardAcceptanceFailureCode,
  options?: { cause?: unknown }
): never {
  throw new DashboardAcceptanceFailure(code, options);
}

function assertAcceptance(
  condition: unknown,
  code: DashboardAcceptanceFailureCode
): asserts condition {
  if (!condition) {
    fail(code);
  }
}

function repositoryRootFromScript(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function cloneManifest(manifest: DashboardManifest): DashboardManifest {
  return DashboardManifestSchema.parse(JSON.parse(canonicalJson(manifest)) as unknown);
}

function configureFirstEdit(manifest: DashboardManifest): DashboardManifest {
  const edited = cloneManifest(manifest);
  edited.template.name = "Sales overview — governed edit";

  const parameter = edited.parameters.find(
    (candidate) => candidate.parameterId === "minimum-sales"
  );
  assertAcceptance(
    parameter !== undefined && parameter.type === "number",
    "draft-save-and-stale-conflict"
  );
  parameter.defaultValue = 125;

  const calculation = edited.calculations.find(
    (candidate) => candidate.calculationId === "total-sales"
  );
  assertAcceptance(calculation !== undefined, "draft-save-and-stale-conflict");
  calculation.label = "Governed total sales";
  assertAcceptance(
    calculation.kind === "portable",
    "draft-save-and-stale-conflict"
  );
  calculation.expression = {
    kind: "operation",
    operator: "multiply",
    operands: [calculation.expression, { kind: "literal", value: 2 }]
  };

  const table = edited.components.find(
    (candidate) => candidate.componentId === "sales-table"
  );
  assertAcceptance(
    table !== undefined && table.type === "data-table",
    "draft-save-and-stale-conflict"
  );
  const salesColumn = table.columns.find(
    (candidate) => candidate.columnId === "table-sales"
  );
  assertAcceptance(salesColumn !== undefined, "draft-save-and-stale-conflict");
  salesColumn.header = "Governed sales";

  const largeTable = edited.layout.large.find(
    (candidate) => candidate.componentId === "sales-table"
  );
  assertAcceptance(largeTable !== undefined, "draft-save-and-stale-conflict");
  largeTable.height = 6;
  edited.theme.accent = "#245C7A";
  return DashboardManifestSchema.parse(edited);
}

function configureSecondEdit(manifest: DashboardManifest): DashboardManifest {
  const edited = cloneManifest(manifest);
  edited.template.name = "Sales overview — second governed edit";
  edited.theme.spacing = "compact";
  return DashboardManifestSchema.parse(edited);
}

function previewRequest(manifest: DashboardManifest) {
  return {
    manifest,
    adapterId: "fixture" as const,
    parameterValues: Object.fromEntries(
      manifest.parameters.map((parameter) => [
        parameter.parameterId,
        parameter.defaultValue
      ])
    ),
    filters: [],
    sort: [],
    page: { offset: 0, limit: 25 }
  };
}

function runtimeConfig(
  repositoryRoot: string,
  evidenceRoot: string
): OrchestratorConfig {
  return {
    host: "127.0.0.1",
    port: 8790,
    repositoryRoot,
    evidenceRoot,
    trustGrantRelativePath: ".local/trust/workspace-grant.json",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    ollamaExecutable: resolve(repositoryRoot, ".local", "acceptance-unused-ollama"),
    whiteshadowBaseUrl: "http://127.0.0.1:8787",
    whiteshadowWorkspace: resolve(
      repositoryRoot,
      ".local",
      "acceptance-unused-whiteshadow"
    ),
    whiteshadowPython: resolve(
      repositoryRoot,
      ".local",
      "acceptance-unused-python"
    ),
    webDistRoot: resolve(repositoryRoot, "apps", "web", "dist")
  };
}

function servicesForDashboard(
  config: OrchestratorConfig,
  dashboardBuilder: DashboardBuilderRouteContext
): OrchestratorServices {
  return {
    config,
    dashboardBuilder,
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

async function startDashboardRuntime(
  repositoryRoot: string,
  evidenceRoot: string
): Promise<ActiveDashboardRuntime> {
  const evidence = new LocalEvidenceStore({ root: evidenceRoot, repositoryRoot });
  await evidence.initialize();
  const sample = await loadDashboardSample(repositoryRoot);
  const service = new DashboardService({
    evidence,
    adapters: new DashboardAdapterRegistry([
      new FixtureDashboardAdapter(sample.fixture, {
        now: () => new Date(FIXED_TIME)
      }),
      new QlikDashboardAdapter({ enabled: false, now: () => new Date(FIXED_TIME) })
    ]),
    now: () => FIXED_TIME
  });
  await service.initialize();
  const dashboardBuilder: DashboardBuilderRouteContext = {
    service,
    sample: {
      manifest: sample.manifest,
      manifestBytes: sample.manifestBytes
    }
  };
  const config = runtimeConfig(repositoryRoot, evidenceRoot);
  const app = await createApp({
    config,
    services: servicesForDashboard(config, dashboardBuilder),
    mountCopilotRuntime: false,
    serveWeb: false
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((done, reject) => {
      server.once("listening", done);
      server.once("error", reject);
    });
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    fail("api-start-failed", { cause: error });
  }
  const address = server.address();
  assertAcceptance(
    address !== null && typeof address !== "string",
    "api-start-failed"
  );
  return {
    baseUrl: `http://127.0.0.1:${String((address as AddressInfo).port)}`,
    close: async () => await closeServer(server)
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  try {
    await new Promise<void>((done, reject) => {
      server.close((error) => (error === undefined ? done() : reject(error)));
    });
  } catch (error) {
    fail("api-shutdown-failed", { cause: error });
  }
}

async function request(
  url: string,
  options: RequestInit | undefined,
  expectedStatus: number,
  failureCode: DashboardAcceptanceFailureCode
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    fail(failureCode, { cause: error });
  }
  assertAcceptance(response.status === expectedStatus, failureCode);
  return response;
}

async function parseJson<T>(
  response: Response,
  schema: RuntimeSchema<T>,
  failureCode: DashboardAcceptanceFailureCode
): Promise<T> {
  try {
    return schema.parse(await response.json());
  } catch (error) {
    fail(failureCode, { cause: error });
  }
}

async function postJson<T>(
  url: string,
  body: unknown,
  expectedStatus: number,
  schema: RuntimeSchema<T>,
  failureCode: DashboardAcceptanceFailureCode
): Promise<T> {
  const response = await request(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    },
    expectedStatus,
    failureCode
  );
  return parseJson(response, schema, failureCode);
}

async function putJson<T>(
  url: string,
  body: unknown,
  expectedStatus: number,
  schema: RuntimeSchema<T>,
  failureCode: DashboardAcceptanceFailureCode
): Promise<T> {
  const response = await request(
    url,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    },
    expectedStatus,
    failureCode
  );
  return parseJson(response, schema, failureCode);
}

async function getJson<T>(
  url: string,
  schema: RuntimeSchema<T>,
  failureCode: DashboardAcceptanceFailureCode
): Promise<{ response: Response; body: T }> {
  const response = await request(url, undefined, 200, failureCode);
  return { response, body: await parseJson(response, schema, failureCode) };
}

async function exerciseLifecycle(
  repositoryRoot: string,
  evidenceRoot: string
): Promise<AcceptanceObservation> {
  const tracked = await loadDashboardSample(repositoryRoot);
  const trackedBytes = Buffer.from(tracked.manifestBytes);
  const templateId = tracked.manifest.template.templateId;
  const encodedTemplateId = encodeURIComponent(templateId);
  let runtime: ActiveDashboardRuntime | undefined;
  let recoveredRuntime: ActiveDashboardRuntime | undefined;
  try {
    runtime = await startDashboardRuntime(repositoryRoot, evidenceRoot);
    const apiRoot = `${runtime.baseUrl}/api/dashboard-builder`;
    const templateUrl = `${apiRoot}/templates/${encodedTemplateId}`;

    const sampleResponse = await request(
      `${apiRoot}/sample`,
      undefined,
      200,
      "tracked-sample-roundtrip"
    );
    const downloadedSample = Buffer.from(await sampleResponse.arrayBuffer());
    assertAcceptance(
      downloadedSample.equals(trackedBytes) &&
        sampleResponse.headers
          .get("content-disposition")
          ?.includes(`${templateId}.dashboard.json`) === true,
      "tracked-sample-roundtrip"
    );

    const importedResponse = await request(
      `${apiRoot}/imports`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: trackedBytes
      },
      201,
      "tracked-sample-roundtrip"
    );
    const imported = await parseJson(
      importedResponse,
      DashboardImportResponseSchema,
      "tracked-sample-roundtrip"
    );
    assertAcceptance(
      imported.receipt.originalUploadSha256 === sha256Hex(trackedBytes) &&
        imported.template.currentRevision === 0,
      "tracked-sample-roundtrip"
    );

    const adapters = await getJson(
      `${apiRoot}/adapters`,
      DashboardAdaptersResponseSchema,
      "qlik-disabled"
    );
    const qlik = adapters.body.items.find((adapter) => adapter.adapterId === "qlik");
    assertAcceptance(
      qlik?.status === "unavailable" &&
        qlik.capabilities.qlikCalculations === false &&
        qlik.capabilities.selections === false,
      "qlik-disabled"
    );

    const draftValidation = await postJson(
      `${templateUrl}/validate`,
      { manifest: tracked.manifest, mode: "draft" },
      200,
      DashboardValidationResultSchema,
      "manifest-validation"
    );
    const publishValidation = await postJson(
      `${templateUrl}/validate`,
      { manifest: tracked.manifest, mode: "publish" },
      200,
      DashboardValidationResultSchema,
      "manifest-validation"
    );
    assertAcceptance(
      draftValidation.valid &&
        publishValidation.valid &&
        publishValidation.publishEligible &&
        publishValidation.normalizedManifest !== null,
      "manifest-validation"
    );

    const initialPreview = await postJson(
      `${templateUrl}/preview`,
      previewRequest(tracked.manifest),
      200,
      DashboardPreviewResponseSchema,
      "fixture-preview-and-build"
    );
    assertAcceptance(
      initialPreview.adapterId === "fixture" &&
        initialPreview.projections.length === tracked.manifest.components.length,
      "fixture-preview-and-build"
    );
    const initialBuild = await getJson(
      `${apiRoot}/builds/${encodeURIComponent(initialPreview.buildId)}`,
      DashboardBuildReceiptSchema,
      "fixture-preview-and-build"
    );
    assertAcceptance(
      initialBuild.body.status === "succeeded" &&
        initialBuild.body.buildId === initialPreview.buildId &&
        initialBuild.body.componentCount === tracked.manifest.components.length,
      "fixture-preview-and-build"
    );

    const firstEdit = configureFirstEdit(tracked.manifest);
    const savedFirst = await putJson(
      `${templateUrl}/draft`,
      {
        expectedRevision: 0,
        actor: "acceptance-editor",
        manifest: firstEdit
      },
      200,
      DashboardDraftUpdateResponseSchema,
      "draft-save-and-stale-conflict"
    );
    assertAcceptance(
      savedFirst.template.currentRevision === 1 &&
        canonicalJson(savedFirst.manifest) === canonicalJson(firstEdit),
      "draft-save-and-stale-conflict"
    );

    const staleResponse = await request(
      `${templateUrl}/draft`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          actor: "stale-editor",
          manifest: firstEdit
        })
      },
      409,
      "draft-save-and-stale-conflict"
    );
    const stale = await parseJson(
      staleResponse,
      DashboardErrorEnvelopeSchema,
      "draft-save-and-stale-conflict"
    );
    assertAcceptance(
      stale.error.code === "revision-conflict" &&
        stale.error.details?.currentRevision === 1 &&
        stale.error.details.templateId === templateId,
      "draft-save-and-stale-conflict"
    );

    const editedValidation = await postJson(
      `${templateUrl}/validate`,
      { manifest: firstEdit, mode: "publish" },
      200,
      DashboardValidationResultSchema,
      "manifest-validation"
    );
    assertAcceptance(
      editedValidation.valid && editedValidation.publishEligible,
      "manifest-validation"
    );
    const editedPreview = await postJson(
      `${templateUrl}/preview`,
      previewRequest(firstEdit),
      200,
      DashboardPreviewResponseSchema,
      "fixture-preview-and-build"
    );
    const editedBuild = await getJson(
      `${apiRoot}/builds/${encodeURIComponent(editedPreview.buildId)}`,
      DashboardBuildReceiptSchema,
      "fixture-preview-and-build"
    );
    const initialSalesKpi = initialPreview.projections.find(
      (projection) => projection.componentId === "sales-kpi"
    );
    const editedSalesKpi = editedPreview.projections.find(
      (projection) => projection.componentId === "sales-kpi"
    );
    assertAcceptance(
      editedBuild.body.status === "succeeded" &&
        editedBuild.body.buildId === editedPreview.buildId &&
        initialSalesKpi?.type === "kpi" &&
        editedSalesKpi?.type === "kpi" &&
        typeof initialSalesKpi.value === "number" &&
        editedSalesKpi.value === initialSalesKpi.value * 2,
      "fixture-preview-and-build"
    );

    const firstPublish = await postJson(
      `${templateUrl}/publish`,
      { expectedRevision: 1, actor: "acceptance-publisher" },
      201,
      DashboardPublishResponseSchema,
      "immutable-revision-download"
    );
    assertAcceptance(
      firstPublish.revision.revisionNumber === 1 &&
        firstPublish.revision.eventType === "published" &&
        firstPublish.template.currentRevision === 2 &&
        firstPublish.receipt.status === "succeeded" &&
        !firstPublish.idempotent,
      "immutable-revision-download"
    );

    const firstRevisionDownload = await getJson(
      `${templateUrl}/revisions/1`,
      DashboardRevisionResponseSchema,
      "immutable-revision-download"
    );
    assertAcceptance(
      firstRevisionDownload.response.headers
        .get("content-disposition")
        ?.includes(`${templateId}.revision-1.dashboard.json`) === true &&
        canonicalJson(firstRevisionDownload.body.manifest) === canonicalJson(firstEdit),
      "immutable-revision-download"
    );
    const immutableFirstRevision = canonicalJson(firstRevisionDownload.body);

    const secondEdit = configureSecondEdit(firstEdit);
    const savedSecond = await putJson(
      `${templateUrl}/draft`,
      {
        expectedRevision: 2,
        actor: "acceptance-editor",
        manifest: secondEdit
      },
      200,
      DashboardDraftUpdateResponseSchema,
      "immutable-revision-download"
    );
    assertAcceptance(
      savedSecond.template.currentRevision === 3,
      "immutable-revision-download"
    );
    const secondPublish = await postJson(
      `${templateUrl}/publish`,
      { expectedRevision: 3, actor: "acceptance-publisher" },
      201,
      DashboardPublishResponseSchema,
      "immutable-revision-download"
    );
    assertAcceptance(
      secondPublish.revision.revisionNumber === 2 &&
        secondPublish.template.currentRevision === 4 &&
        secondPublish.receipt.status === "succeeded",
      "immutable-revision-download"
    );
    const firstRevisionAfterSecondPublish = await getJson(
      `${templateUrl}/revisions/1`,
      DashboardRevisionResponseSchema,
      "immutable-revision-download"
    );
    assertAcceptance(
      canonicalJson(firstRevisionAfterSecondPublish.body) === immutableFirstRevision,
      "immutable-revision-download"
    );

    const rolledBack = await postJson(
      `${templateUrl}/rollback`,
      {
        expectedRevision: 4,
        targetRevisionNumber: 1,
        actor: "acceptance-publisher"
      },
      201,
      DashboardRollbackResponseSchema,
      "rollback"
    );
    assertAcceptance(
      rolledBack.template.currentRevision === 5 &&
        rolledBack.template.activeRevisionNumber === 3 &&
        rolledBack.revision.revisionNumber === 3 &&
        rolledBack.revision.eventType === "rollback" &&
        rolledBack.revision.sourceRevisionNumber === 1,
      "rollback"
    );
    const rolledBackDetail = await getJson(
      templateUrl,
      DashboardTemplateResponseSchema,
      "rollback"
    );
    assertAcceptance(
      canonicalJson(rolledBackDetail.body.manifest) === canonicalJson(firstEdit),
      "rollback"
    );

    await runtime.close();
    runtime = undefined;
    recoveredRuntime = await startDashboardRuntime(repositoryRoot, evidenceRoot);
    const recoveredApiRoot = `${recoveredRuntime.baseUrl}/api/dashboard-builder`;
    const recoveredTemplateUrl = `${recoveredApiRoot}/templates/${encodedTemplateId}`;
    const recovered = await getJson(
      recoveredTemplateUrl,
      DashboardTemplateResponseSchema,
      "persistence-replay"
    );
    const recoveredRevisions = await getJson(
      `${recoveredTemplateUrl}/revisions`,
      DashboardRevisionListResponseSchema,
      "persistence-replay"
    );
    const recoveredFirstRevision = await getJson(
      `${recoveredTemplateUrl}/revisions/1`,
      DashboardRevisionResponseSchema,
      "persistence-replay"
    );
    assertAcceptance(
      recovered.body.template.integrity === "verified" &&
        recovered.body.template.currentRevision === 5 &&
        recovered.body.template.activeRevisionNumber === 3 &&
        canonicalJson(recovered.body.manifest) === canonicalJson(firstEdit) &&
        recoveredRevisions.body.items.length === 3 &&
        canonicalJson(recoveredFirstRevision.body) === immutableFirstRevision,
      "persistence-replay"
    );

    const malicious = cloneManifest(tracked.manifest) as DashboardManifest & {
      jsx?: string;
    };
    malicious.template.templateId = "malicious-dashboard-sample";
    malicious.template.description = "<script>untrusted()</script>";
    malicious.jsx = "export default function Untrusted() {}";
    const maliciousResponse = await request(
      `${recoveredApiRoot}/imports`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(malicious)
      },
      422,
      "malicious-manifest-rejection"
    );
    const rejected = await parseJson(
      maliciousResponse,
      DashboardErrorEnvelopeSchema,
      "malicious-manifest-rejection"
    );
    const gallery = await getJson(
      `${recoveredApiRoot}/templates`,
      DashboardTemplateListResponseSchema,
      "malicious-manifest-rejection"
    );
    assertAcceptance(
      rejected.error.code === "dashboard-validation-failed" &&
        rejected.error.details === null &&
        gallery.body.items.length === 1,
      "malicious-manifest-rejection"
    );

    return {
      sampleBytes: trackedBytes.byteLength,
      sampleSha256: sha256Hex(trackedBytes),
      normalizedManifestSha256: imported.receipt.normalizedManifestSha256,
      componentProjectionCount: initialPreview.projections.length,
      previewBuildFingerprintSha256: sha256Hex(initialPreview.buildId),
      templateCount: gallery.body.items.length,
      successfulBuildCount: new Set([
        initialBuild.body.buildId,
        editedBuild.body.buildId,
        firstPublish.receipt.buildId,
        secondPublish.receipt.buildId
      ]).size,
      staleConflictCount: 1,
      publishedRevisionCount: recoveredRevisions.body.items.filter(
        (revision) => revision.eventType === "published"
      ).length,
      rollbackRevisionCount: recoveredRevisions.body.items.filter(
        (revision) => revision.eventType === "rollback"
      ).length,
      recoveredRevisionCount: recoveredRevisions.body.items.length,
      rejectedMaliciousUploadCount: 1,
      finalCurrentRevision: recovered.body.template.currentRevision,
      activeRevisionNumber: recovered.body.template.activeRevisionNumber ?? 0
    };
  } finally {
    if (runtime !== undefined) {
      await runtime.close();
    }
    if (recoveredRuntime !== undefined) {
      await recoveredRuntime.close();
    }
  }
}

function checks(): DashboardAcceptanceCheck[] {
  return [
    "tracked-sample-roundtrip",
    "manifest-validation",
    "fixture-preview-and-build",
    "draft-save-and-stale-conflict",
    "immutable-revision-download",
    "rollback",
    "persistence-replay",
    "malicious-manifest-rejection",
    "qlik-disabled"
  ].map((code) => ({ code, passed: true })) as DashboardAcceptanceCheck[];
}

function buildReport(
  observation: AcceptanceObservation
): SanitizedDashboardAcceptanceReport {
  const reportWithoutFingerprint = {
    schemaVersion: REPORT_SCHEMA_VERSION as typeof REPORT_SCHEMA_VERSION,
    accepted: true as const,
    boundary: {
      mode: "tracked-fixture" as const,
      transport: "ephemeral-loopback" as const,
      qlik: "disabled" as const,
      evidence: "temporary-cleaned" as const
    },
    artifact: {
      sampleBytes: observation.sampleBytes,
      sampleSha256: observation.sampleSha256,
      normalizedManifestSha256: observation.normalizedManifestSha256
    },
    lifecycle: {
      templateCount: observation.templateCount,
      componentProjectionCount: observation.componentProjectionCount,
      successfulBuildCount: observation.successfulBuildCount,
      staleConflictCount: observation.staleConflictCount,
      publishedRevisionCount: observation.publishedRevisionCount,
      rollbackRevisionCount: observation.rollbackRevisionCount,
      recoveredRevisionCount: observation.recoveredRevisionCount,
      rejectedMaliciousUploadCount: observation.rejectedMaliciousUploadCount,
      finalCurrentRevision: observation.finalCurrentRevision,
      activeRevisionNumber: observation.activeRevisionNumber,
      previewBuildFingerprintSha256: observation.previewBuildFingerprintSha256
    },
    checks: checks()
  };
  return {
    schemaVersion: reportWithoutFingerprint.schemaVersion,
    accepted: reportWithoutFingerprint.accepted,
    runFingerprintSha256: sha256Hex(canonicalJson(reportWithoutFingerprint)),
    boundary: reportWithoutFingerprint.boundary,
    artifact: reportWithoutFingerprint.artifact,
    lifecycle: reportWithoutFingerprint.lifecycle,
    checks: reportWithoutFingerprint.checks
  };
}

function assertTemporaryRoot(
  repositoryRoot: string,
  localRoot: string,
  temporaryRoot: string
): void {
  const relativeToRepository = relative(repositoryRoot, temporaryRoot);
  const relativeToLocal = relative(localRoot, temporaryRoot);
  assertAcceptance(
    isAbsolute(temporaryRoot) &&
      relativeToRepository.startsWith(`.local${sep}${TEMPORARY_ROOT_PREFIX}`) &&
      relativeToLocal.length > 0 &&
      !relativeToLocal.startsWith(`..${sep}`) &&
      relativeToLocal !== ".." &&
      !isAbsolute(relativeToLocal) &&
      basename(temporaryRoot).startsWith(TEMPORARY_ROOT_PREFIX),
    "temporary-root-invalid"
  );
}

async function removeTemporaryRoot(
  repositoryRoot: string,
  localRoot: string,
  temporaryRoot: string
): Promise<void> {
  assertTemporaryRoot(repositoryRoot, localRoot, temporaryRoot);
  try {
    await rm(temporaryRoot, { recursive: true, force: false });
    await access(temporaryRoot);
    fail("temporary-cleanup-failed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    if (error instanceof DashboardAcceptanceFailure) {
      throw error;
    }
    fail("temporary-cleanup-failed", { cause: error });
  }
}

export function serializeSanitizedDashboardAcceptanceReport(
  report: SanitizedDashboardAcceptanceReport
): string {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const unsafeField =
    /"(?:manifest|rows|projections|sourceReference|evidenceRoot|temporaryRoot|authorization|token|password|secret|jsx|javascript|html)"\s*:/iu.test(
      serialized
    );
  const credentialPattern =
    /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_=-]{8,}\b/iu.test(serialized) ||
    /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/iu.test(serialized);
  const executablePattern = /<\/?script\b|(?:javascript|data):/iu.test(serialized);
  if (
    Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES ||
    unsafeField ||
    credentialPattern ||
    executablePattern
  ) {
    fail("report-safety-failed");
  }
  return serialized;
}

export function formatDashboardAcceptanceFailure(error: unknown): string {
  if (error instanceof DashboardAcceptanceFailure) {
    return `Dashboard builder local acceptance failed: ${SAFE_FAILURE_MESSAGES[error.code]}`;
  }
  return "Dashboard builder local acceptance failed before a sanitized result was available.";
}

export async function runDashboardBuilderLocalAcceptance(
  repositoryRoot: string = repositoryRootFromScript()
): Promise<SanitizedDashboardAcceptanceReport> {
  const canonicalRepositoryRoot = resolve(repositoryRoot);
  const localRoot = resolve(canonicalRepositoryRoot, ".local");
  await mkdir(localRoot, { recursive: true });
  let temporaryRoot: string;
  try {
    temporaryRoot = await mkdtemp(resolve(localRoot, TEMPORARY_ROOT_PREFIX));
  } catch (error) {
    fail("temporary-root-invalid", { cause: error });
  }
  assertTemporaryRoot(canonicalRepositoryRoot, localRoot, temporaryRoot);

  let observation: AcceptanceObservation | undefined;
  let lifecycleError: unknown;
  try {
    observation = await exerciseLifecycle(canonicalRepositoryRoot, temporaryRoot);
  } catch (error) {
    lifecycleError = error;
  }

  await removeTemporaryRoot(canonicalRepositoryRoot, localRoot, temporaryRoot);
  if (lifecycleError !== undefined) {
    throw lifecycleError;
  }
  assertAcceptance(observation !== undefined, "api-request-failed");
  const report = buildReport(observation);
  serializeSanitizedDashboardAcceptanceReport(report);
  return report;
}

async function runCli(arguments_: readonly string[]): Promise<void> {
  if (arguments_.length !== 1 || arguments_[0] !== "--local") {
    fail("explicit-local-opt-in-required");
  }
  const report = await runDashboardBuilderLocalAcceptance();
  process.stdout.write(serializeSanitizedDashboardAcceptanceReport(report));
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${formatDashboardAcceptanceFailure(error)}\n`);
    process.exitCode = 1;
  });
}
