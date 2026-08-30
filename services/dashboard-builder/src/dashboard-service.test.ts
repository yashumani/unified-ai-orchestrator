import {
  DashboardAdapterStatusSchema,
  DashboardBuildReceiptSchema,
  DashboardImportReceiptSchema,
  DashboardPreviewResponseSchema,
  DashboardTemplateEventSchema,
  type DashboardAdapterStatus,
  type DashboardBuildReceipt,
  type DashboardImportReceipt,
  type DashboardManifest,
  type DashboardPreviewRequest,
  type DashboardPreviewResponse,
  type DashboardTemplateEvent
} from "@unified-ai/contracts/dashboard-builder";
import { canonicalJson, sha256Hex } from "@unified-ai/evidence-index";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DashboardService,
  type DashboardEvidencePort,
  type DashboardStoredObject
} from "./dashboard-service.js";
import {
  DashboardAdapterRegistry,
  type DashboardDataAdapter
} from "./data-adapter.js";
import { DashboardBuilderError } from "./errors.js";
import { loadDashboardSample } from "./sample-loader.js";

const now = "2026-08-29T16:00:00.000Z";

function clone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

class MemoryEvidence implements DashboardEvidencePort {
  readonly objects = new Map<string, string>();
  readonly events = new Map<string, Map<string, string>>();
  readonly builds = new Map<string, string>();
  readonly imports = new Map<string, string>();
  failNextEvent = false;

  async putObject(value: unknown): Promise<DashboardStoredObject> {
    const content = canonicalJson(value);
    const sha256 = sha256Hex(content);
    const existing = this.objects.get(sha256);
    if (existing !== undefined && existing !== content) {
      throw new Error("object hash collision");
    }
    this.objects.set(sha256, content);
    return { sha256, relativePath: `objects/${sha256}.json` };
  }

  async readObject(sha256: string): Promise<unknown> {
    const content = this.objects.get(sha256);
    if (content === undefined || sha256Hex(content) !== sha256) {
      throw new Error("object integrity failure");
    }
    return JSON.parse(content) as unknown;
  }

  async listDashboardTemplateIds(): Promise<string[]> {
    return [...this.events.keys()].sort();
  }

  async putDashboardTemplateEvent(
    value: DashboardTemplateEvent
  ): Promise<DashboardStoredObject> {
    if (this.failNextEvent) {
      this.failNextEvent = false;
      throw new Error("injected event append failure");
    }
    const event = DashboardTemplateEventSchema.parse(value);
    const records = this.events.get(event.templateId) ?? new Map<string, string>();
    this.events.set(event.templateId, records);
    return this.#putNamed(records, event.eventId, event, "events");
  }

  async listDashboardTemplateEvents(templateId: string): Promise<DashboardTemplateEvent[]> {
    return [...(this.events.get(templateId)?.values() ?? [])]
      .map((content) => DashboardTemplateEventSchema.parse(JSON.parse(content) as unknown))
      .sort((left, right) => left.sequence - right.sequence);
  }

  async putDashboardBuildReceipt(
    value: DashboardBuildReceipt
  ): Promise<DashboardStoredObject> {
    const receipt = DashboardBuildReceiptSchema.parse(value);
    return this.#putNamed(this.builds, receipt.buildId, receipt, "builds");
  }

  async readDashboardBuildReceipt(buildId: string): Promise<DashboardBuildReceipt> {
    const content = this.builds.get(buildId);
    if (content === undefined) {
      throw new Error("build not found");
    }
    return DashboardBuildReceiptSchema.parse(JSON.parse(content) as unknown);
  }

  async putDashboardImportReceipt(
    value: DashboardImportReceipt
  ): Promise<DashboardStoredObject> {
    const receipt = DashboardImportReceiptSchema.parse(value);
    return this.#putNamed(this.imports, receipt.importId, receipt, "imports");
  }

  async readDashboardImportReceipt(importId: string): Promise<DashboardImportReceipt> {
    const content = this.imports.get(importId);
    if (content === undefined) {
      throw new Error("import not found");
    }
    return DashboardImportReceiptSchema.parse(JSON.parse(content) as unknown);
  }

  tamperPreviousEventHash(templateId: string, sequence: number): void {
    const records = this.events.get(templateId);
    const entry = [...(records?.entries() ?? [])].find(([, content]) => {
      const parsed = DashboardTemplateEventSchema.parse(JSON.parse(content) as unknown);
      return parsed.sequence === sequence;
    });
    if (entry === undefined || records === undefined) {
      throw new Error("event to tamper was not found");
    }
    const parsed = JSON.parse(entry[1]) as Record<string, unknown>;
    parsed.previousEventSha256 = "f".repeat(64);
    records.set(entry[0], canonicalJson(parsed));
  }

  async #putNamed(
    records: Map<string, string>,
    id: string,
    value: unknown,
    directory: string
  ): Promise<DashboardStoredObject> {
    const content = canonicalJson(value);
    const existing = records.get(id);
    if (existing !== undefined && existing !== content) {
      throw new Error("immutable evidence path already contains different content");
    }
    records.set(id, content);
    return {
      sha256: sha256Hex(content),
      relativePath: `${directory}/${id}.json`
    };
  }
}

class FakeAdapter implements DashboardDataAdapter {
  readonly adapterId: "fixture" | "qlik";
  readonly #ready: boolean;

  constructor(adapterId: "fixture" | "qlik", ready: boolean) {
    this.adapterId = adapterId;
    this.#ready = ready;
  }

  async status(): Promise<DashboardAdapterStatus> {
    return DashboardAdapterStatusSchema.parse({
      adapterId: this.adapterId,
      label: this.adapterId === "fixture" ? "Synthetic fixture" : "Qlik",
      status: this.#ready ? "ready" : "unavailable",
      capabilities: {
        portableCalculations: this.#ready,
        qlikCalculations: this.adapterId === "qlik" && this.#ready,
        selections: this.#ready,
        paging: this.#ready
      },
      diagnostics: this.#ready
        ? []
        : [
            {
              severity: "warning",
              code: "adapter-unavailable",
              path: "",
              message: "The adapter is not configured."
            }
          ]
    });
  }

  async preview(request: DashboardPreviewRequest): Promise<DashboardPreviewResponse> {
    if (!this.#ready) {
      throw new DashboardBuilderError(
        "adapter-unavailable",
        "The requested dashboard adapter is unavailable."
      );
    }
    return DashboardPreviewResponseSchema.parse({
      buildId: `fake-build-${this.adapterId}`,
      templateId: request.manifest.template.templateId,
      manifestSha256: sha256Hex(canonicalJson(request.manifest)),
      adapterId: this.adapterId,
      generatedAt: now,
      projections: request.manifest.components.map((component) => {
        const base = {
          componentId: component.componentId,
          title: component.title,
          status: "ready" as const,
          diagnostics: []
        };
        if (component.type === "kpi") {
          return {
            ...base,
            type: "kpi" as const,
            value: 1,
            formattedValue: "1"
          };
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
            offset: request.page.offset,
            limit: request.page.limit
          };
        }
        if (component.type === "bar-chart" || component.type === "line-chart") {
          return {
            ...base,
            type: component.type,
            series: component.calculationIds.map((calculationId) => ({
              calculationId,
              label:
                request.manifest.calculations.find(
                  (calculation) => calculation.calculationId === calculationId
                )?.label ?? calculationId,
              points: []
            }))
          };
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
}

function registry(): DashboardAdapterRegistry {
  return new DashboardAdapterRegistry([
    new FakeAdapter("fixture", true),
    new FakeAdapter("qlik", false)
  ]);
}

function createService(evidence: MemoryEvidence): DashboardService {
  return new DashboardService({ evidence, adapters: registry(), now: () => now });
}

function previewRequest(manifest: DashboardManifest): DashboardPreviewRequest {
  return {
    manifest,
    adapterId: "fixture",
    parameterValues: Object.fromEntries(
      manifest.parameters.map((parameter) => [parameter.parameterId, parameter.defaultValue])
    ),
    filters: [],
    sort: [],
    page: { offset: 0, limit: 100 }
  };
}

let sampleManifest: DashboardManifest;
let sampleBytes: Uint8Array;

beforeEach(async () => {
  const sample = await loadDashboardSample(process.cwd());
  sampleManifest = sample.manifest;
  sampleBytes = sample.manifestBytes;
});

describe("dashboard lifecycle service", () => {
  it("imports raw sample bytes atomically and preserves original and normalized hashes", async () => {
    const evidence = new MemoryEvidence();
    const service = createService(evidence);
    await service.initialize();

    const response = await service.importManifest(sampleBytes, "local-operator");

    expect(response.template).toMatchObject({
      templateId: "sales-overview",
      currentRevision: 0,
      activeRevisionNumber: null,
      integrity: "verified"
    });
    expect(response.receipt.originalUploadSha256).toBe(sha256Hex(sampleBytes));
    expect(response.receipt.normalizedManifestSha256).toBe(
      sha256Hex(canonicalJson(sampleManifest))
    );
    expect(service.getTemplate("sales-overview").manifest).toEqual(sampleManifest);
    expect(service.listTemplates().items).toHaveLength(1);
    await expect(
      service.importManifest(sampleBytes, "local-operator")
    ).rejects.toMatchObject({ code: "revision-conflict" });
  });

  it("rejects invalid uploads before the first persistence write", async () => {
    const evidence = new MemoryEvidence();
    const service = createService(evidence);
    await service.initialize();
    const hostile = Buffer.from(
      JSON.stringify({ ...sampleManifest, jsx: "export default function App() {}" })
    );

    await expect(
      service.importManifest(hostile, "local-operator")
    ).rejects.toMatchObject({ code: "dashboard-validation-failed" });
    await expect(
      service.importManifest(sampleBytes, "Not A Stable Actor")
    ).rejects.toThrow();
    expect(evidence.objects.size).toBe(0);
    expect(evidence.events.size).toBe(0);
    expect(evidence.imports.size).toBe(0);
  });

  it("serializes draft updates and returns safe stale-revision conflicts", async () => {
    const evidence = new MemoryEvidence();
    const service = createService(evidence);
    await service.initialize();
    await service.importManifest(sampleBytes, "local-operator");
    const first = clone(sampleManifest);
    const second = clone(sampleManifest);
    if (first.parameters[0]?.type !== "number" || second.parameters[0]?.type !== "number") {
      throw new Error("sample requires a number parameter");
    }
    first.parameters[0].defaultValue = 100;
    second.parameters[0].defaultValue = 200;

    const results = await Promise.allSettled([
      service.updateDraft("sales-overview", {
        expectedRevision: 0,
        actor: "editor-one",
        manifest: first
      }),
      service.updateDraft("sales-overview", {
        expectedRevision: 0,
        actor: "editor-two",
        manifest: second
      })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: {
        code: "revision-conflict",
        details: { templateId: "sales-overview", currentRevision: 1 }
      }
    });
    expect(service.getTemplate("sales-overview").template.currentRevision).toBe(1);
  });

  it("persists previews, publishes idempotently, versions edits, and rolls back", async () => {
    const evidence = new MemoryEvidence();
    const service = createService(evidence);
    await service.initialize();
    await service.importManifest(sampleBytes, "local-operator");

    const preview = await service.preview(previewRequest(sampleManifest));
    await expect(service.getBuild(preview.buildId)).resolves.toMatchObject({
      buildId: preview.buildId,
      draftRevision: 0,
      status: "succeeded"
    });
    const firstPublish = await service.publish("sales-overview", {
      expectedRevision: 0,
      actor: "publisher"
    });
    expect(firstPublish).toMatchObject({
      idempotent: false,
      revision: { revisionNumber: 1, eventType: "published" },
      template: { currentRevision: 1, activeRevisionNumber: 1 }
    });
    const repeated = await service.publish("sales-overview", {
      expectedRevision: 1,
      actor: "publisher"
    });
    expect(repeated.idempotent).toBe(true);
    expect(service.listRevisions("sales-overview").items).toHaveLength(1);

    const edited = clone(sampleManifest);
    edited.template.name = "Edited sales overview";
    await service.updateDraft("sales-overview", {
      expectedRevision: 1,
      actor: "editor",
      manifest: edited
    });
    const secondPublish = await service.publish("sales-overview", {
      expectedRevision: 2,
      actor: "publisher"
    });
    expect(secondPublish.revision.revisionNumber).toBe(2);
    const rolledBack = await service.rollback("sales-overview", {
      expectedRevision: 3,
      actor: "publisher",
      targetRevisionNumber: 1
    });
    expect(rolledBack.revision).toMatchObject({
      revisionNumber: 3,
      eventType: "rollback",
      sourceRevisionNumber: 1
    });
    expect(service.getTemplate("sales-overview").manifest.template.name).toBe(
      sampleManifest.template.name
    );
    expect(service.getRevision("sales-overview", 2).manifest.template.name).toBe(
      "Edited sales overview"
    );
  });

  it("previews a validated unsaved draft without mutating its saved revision", async () => {
    const evidence = new MemoryEvidence();
    const service = createService(evidence);
    await service.initialize();
    await service.importManifest(sampleBytes, "local-operator");
    const edited = clone(sampleManifest);
    edited.template.name = "Live unsaved preview";

    const preview = await service.preview(previewRequest(edited));
    const receipt = await service.getBuild(preview.buildId);

    expect(preview).toMatchObject({
      templateId: "sales-overview",
      manifestSha256: sha256Hex(canonicalJson(edited))
    });
    expect(receipt).toMatchObject({
      draftRevision: 0,
      manifestSha256: preview.manifestSha256,
      status: "succeeded"
    });
    expect(evidence.objects.has(receipt.validationObjectSha256)).toBe(true);
    expect(service.getTemplate("sales-overview")).toMatchObject({
      template: { currentRevision: 0 },
      manifest: { template: { name: sampleManifest.template.name } }
    });
  });

  it("recovers projections from verified events and blocks a broken hash chain", async () => {
    const evidence = new MemoryEvidence();
    const service = createService(evidence);
    await service.initialize();
    await service.importManifest(sampleBytes, "local-operator");
    await service.publish("sales-overview", {
      expectedRevision: 0,
      actor: "publisher"
    });

    const recovered = createService(evidence);
    await recovered.initialize();
    expect(recovered.getTemplate("sales-overview").template).toMatchObject({
      currentRevision: 1,
      activeRevisionNumber: 1,
      integrity: "verified"
    });
    expect(recovered.listRevisions("sales-overview").items).toHaveLength(1);

    evidence.tamperPreviousEventHash("sales-overview", 1);
    const blocked = createService(evidence);
    await blocked.initialize();
    expect(blocked.listTemplates().items).toEqual([
      expect.objectContaining({ templateId: "sales-overview", integrity: "blocked" })
    ]);
    expect(() => blocked.getTemplate("sales-overview")).toThrowError(
      expect.objectContaining({ code: "evidence-integrity-failed" })
    );
  });

  it("leaves the prior projection active when the final event append fails", async () => {
    const evidence = new MemoryEvidence();
    const service = createService(evidence);
    await service.initialize();
    await service.importManifest(sampleBytes, "local-operator");
    const edited = clone(sampleManifest);
    edited.template.name = "Uncommitted edit";
    evidence.failNextEvent = true;

    await expect(
      service.updateDraft("sales-overview", {
        expectedRevision: 0,
        actor: "editor",
        manifest: edited
      })
    ).rejects.toThrow(/event append failure/u);
    expect(service.getTemplate("sales-overview").template.currentRevision).toBe(0);
    expect(service.getTemplate("sales-overview").manifest.template.name).toBe(
      sampleManifest.template.name
    );

    const recovered = createService(evidence);
    await recovered.initialize();
    expect(recovered.getTemplate("sales-overview").template.currentRevision).toBe(0);
    expect(evidence.objects.size).toBeGreaterThan(3);
  });

  it("reports the separately gated Qlik adapter without inventing preview data", async () => {
    const evidence = new MemoryEvidence();
    const service = createService(evidence);
    await service.initialize();
    await service.importManifest(sampleBytes, "local-operator");
    expect(await service.listAdapterStatuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ adapterId: "qlik", status: "unavailable" })
      ])
    );
    await expect(
      service.preview({ ...previewRequest(sampleManifest), adapterId: "qlik" })
    ).rejects.toMatchObject({ code: "adapter-unavailable" });
  });
});
