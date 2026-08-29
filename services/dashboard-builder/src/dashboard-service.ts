import {
  DASHBOARD_MAX_PREVIEW_ROWS,
  DASHBOARD_MAX_UPLOAD_BYTES,
  DashboardBuildReceiptSchema,
  DashboardDraftUpdateRequestSchema,
  DashboardDraftUpdateResponseSchema,
  DashboardImportReceiptSchema,
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
  DashboardTemplateEventSchema,
  DashboardTemplateListResponseSchema,
  DashboardTemplateResponseSchema,
  DashboardTemplateSummarySchema,
  DashboardValidationResultSchema,
  type DashboardAdapterStatus,
  type DashboardBuildReceipt,
  type DashboardDraftUpdateRequest,
  type DashboardDraftUpdateResponse,
  type DashboardImportReceipt,
  type DashboardImportResponse,
  type DashboardManifest,
  type DashboardPreviewRequest,
  type DashboardPreviewResponse,
  type DashboardPublishRequest,
  type DashboardPublishResponse,
  type DashboardRevisionResponse,
  type DashboardRevisionSummary,
  type DashboardRollbackRequest,
  type DashboardRollbackResponse,
  type DashboardTemplateEvent,
  type DashboardTemplateListResponse,
  type DashboardTemplateResponse,
  type DashboardTemplateSummary,
  type DashboardValidationResult
} from "@unified-ai/contracts/dashboard-builder";
import { StableIdSchema } from "@unified-ai/contracts";
import { canonicalJson, sha256Hex } from "@unified-ai/evidence-index";
import { DashboardAdapterRegistry } from "./data-adapter.js";
import { DashboardBuilderError } from "./errors.js";
import { validateDashboardManifest } from "./validation.js";

export interface DashboardStoredObject {
  sha256: string;
  relativePath: string;
}

export interface DashboardEvidencePort {
  putObject(value: unknown): Promise<DashboardStoredObject>;
  readObject(sha256: string): Promise<unknown>;
  listDashboardTemplateIds(): Promise<string[]>;
  putDashboardTemplateEvent(event: DashboardTemplateEvent): Promise<DashboardStoredObject>;
  listDashboardTemplateEvents(templateId: string): Promise<DashboardTemplateEvent[]>;
  putDashboardBuildReceipt(receipt: DashboardBuildReceipt): Promise<DashboardStoredObject>;
  readDashboardBuildReceipt(buildId: string): Promise<DashboardBuildReceipt>;
  putDashboardImportReceipt(receipt: DashboardImportReceipt): Promise<DashboardStoredObject>;
  readDashboardImportReceipt(importId: string): Promise<DashboardImportReceipt>;
}

interface DashboardRevisionState {
  summary: DashboardRevisionSummary;
  manifest: DashboardManifest;
  receipt: DashboardBuildReceipt;
}

interface DashboardTemplateState {
  integrity: "verified";
  manifest: DashboardManifest;
  validation: DashboardValidationResult;
  manifestObjectSha256: string;
  validationObjectSha256: string;
  currentRevision: number;
  lastEventSha256: string;
  activeRevisionNumber: number | null;
  revisions: Map<number, DashboardRevisionState>;
}

interface BlockedDashboardTemplateState {
  integrity: "blocked";
  templateId: string;
}

type StoredDashboardTemplateState =
  | DashboardTemplateState
  | BlockedDashboardTemplateState;

export interface DashboardServiceOptions {
  evidence: DashboardEvidencePort;
  adapters: DashboardAdapterRegistry;
  now?: () => string;
}

function safeId(prefix: string, value: unknown): string {
  return `${prefix}-${sha256Hex(canonicalJson(value)).slice(0, 24)}`;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function rowCount(response: DashboardPreviewResponse): number {
  let count = 0;
  for (const projection of response.projections) {
    if (projection.type === "data-table") {
      count = Math.max(count, projection.totalRows);
    } else if (projection.type === "bar-chart" || projection.type === "line-chart") {
      for (const series of projection.series) {
        count = Math.max(count, series.points.length);
      }
    } else if (projection.type === "filter") {
      count = Math.max(
        count,
        projection.options.reduce((total, option) => total + option.count, 0)
      );
    }
  }
  return Math.min(count, 1_000_000);
}

function eventHash(event: DashboardTemplateEvent): string {
  return sha256Hex(canonicalJson(event));
}

export class DashboardService {
  readonly #evidence: DashboardEvidencePort;
  readonly #adapters: DashboardAdapterRegistry;
  readonly #now: () => string;
  readonly #templates = new Map<string, StoredDashboardTemplateState>();
  readonly #mutationQueues = new Map<string, Promise<void>>();
  #initialized = false;

  constructor(options: DashboardServiceOptions) {
    this.#evidence = options.evidence;
    this.#adapters = options.adapters;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async initialize(): Promise<void> {
    const templateIds = await this.#evidence.listDashboardTemplateIds();
    const recovered = new Map<string, StoredDashboardTemplateState>();
    for (const templateId of templateIds) {
      try {
        const events = await this.#evidence.listDashboardTemplateEvents(templateId);
        if (events.length === 0) {
          continue;
        }
        recovered.set(templateId, await this.#replayTemplate(templateId, events));
      } catch {
        recovered.set(templateId, { integrity: "blocked", templateId });
      }
    }
    this.#templates.clear();
    for (const [templateId, state] of recovered) {
      this.#templates.set(templateId, state);
    }
    this.#initialized = true;
  }

  listTemplates(): DashboardTemplateListResponse {
    this.#assertInitialized();
    const items = [...this.#templates.values()]
      .map((state) => this.#summary(state))
      .sort((left, right) =>
        left.name.localeCompare(right.name) ||
        left.templateId.localeCompare(right.templateId)
      );
    return DashboardTemplateListResponseSchema.parse({ items });
  }

  getTemplate(templateId: string): DashboardTemplateResponse {
    const state = this.#requireTemplate(templateId);
    return DashboardTemplateResponseSchema.parse({
      template: this.#summary(state),
      manifest: state.manifest,
      validation: state.validation
    });
  }

  listRevisions(templateId: string): { items: DashboardRevisionSummary[] } {
    const state = this.#requireTemplate(templateId);
    return DashboardRevisionListResponseSchema.parse({
      items: [...state.revisions.values()]
        .map((revision) => revision.summary)
        .sort((left, right) => left.revisionNumber - right.revisionNumber)
    });
  }

  getRevision(templateId: string, revisionNumber: number): DashboardRevisionResponse {
    const state = this.#requireTemplate(templateId);
    if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
      throw new DashboardBuilderError(
        "invalid-dashboard-request",
        "The dashboard revision number must be a positive integer."
      );
    }
    const revision = state.revisions.get(revisionNumber);
    if (revision === undefined) {
      throw new DashboardBuilderError(
        "template-not-found",
        "The requested dashboard revision was not found."
      );
    }
    return DashboardRevisionResponseSchema.parse({
      revision: revision.summary,
      manifest: revision.manifest
    });
  }

  async getBuild(buildId: string): Promise<DashboardBuildReceipt> {
    this.#assertInitialized();
    try {
      return DashboardBuildReceiptSchema.parse(
        await this.#evidence.readDashboardBuildReceipt(buildId)
      );
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      throw new DashboardBuilderError(
        missing ? "template-not-found" : "evidence-integrity-failed",
        missing
          ? "The requested dashboard build was not found."
          : "The dashboard build evidence failed verification.",
        { cause: error }
      );
    }
  }

  async listAdapterStatuses(): Promise<DashboardAdapterStatus[]> {
    this.#assertInitialized();
    return this.#adapters.listStatuses();
  }

  validate(input: unknown): DashboardValidationResult {
    this.#assertInitialized();
    return validateDashboardManifest(input);
  }

  async importManifest(
    uploadBytes: Uint8Array,
    actor: string
  ): Promise<DashboardImportResponse> {
    this.#assertInitialized();
    const parsedActor = StableIdSchema.parse(actor);
    if (uploadBytes.byteLength < 1 || uploadBytes.byteLength > DASHBOARD_MAX_UPLOAD_BYTES) {
      throw new DashboardBuilderError(
        "invalid-dashboard-request",
        "The dashboard upload must be non-empty and no larger than 1 MiB."
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(Buffer.from(uploadBytes).toString("utf8")) as unknown;
    } catch (error) {
      throw new DashboardBuilderError(
        "invalid-dashboard-request",
        "The dashboard upload must contain valid JSON.",
        { cause: error }
      );
    }
    const validation = validateDashboardManifest(input);
    if (!validation.valid || validation.normalizedManifest === null) {
      throw new DashboardBuilderError(
        "dashboard-validation-failed",
        "The dashboard upload failed manifest validation."
      );
    }
    const manifest = validation.normalizedManifest;
    const templateId = manifest.template.templateId;
    return this.#serialize(templateId, async () => {
      if (this.#templates.has(templateId)) {
        const existing = this.#templates.get(templateId);
        throw new DashboardBuilderError(
          "revision-conflict",
          "A dashboard template with this identifier already exists.",
          {
            details: {
              templateId,
              currentRevision:
                existing?.integrity === "verified" ? existing.currentRevision : 0
            }
          }
        );
      }
      const occurredAt = this.#now();
      const originalUploadSha256 = sha256Hex(uploadBytes);
      const receipt = DashboardImportReceiptSchema.parse({
        schemaVersion: "dashboard-import-receipt/v1",
        importId: safeId("dashboard-import", {
          templateId,
          originalUploadSha256,
          occurredAt
        }),
        templateId,
        actor: parsedActor,
        occurredAt,
        uploadBytes: uploadBytes.byteLength,
        originalUploadSha256,
        normalizedManifestSha256: validation.manifestSha256,
        diagnosticCodes: validation.diagnostics.map((diagnostic) => diagnostic.code)
      });
      const manifestObject = await this.#evidence.putObject(manifest);
      const validationObject = await this.#evidence.putObject(validation);
      await this.#evidence.putDashboardImportReceipt(receipt);
      const receiptObject = await this.#evidence.putObject(receipt);
      const event = DashboardTemplateEventSchema.parse({
        schemaVersion: "dashboard-template-event/v1",
        eventId: safeId("dashboard-event", {
          templateId,
          sequence: 0,
          eventType: "imported",
          manifestSha256: validation.manifestSha256
        }),
        templateId,
        sequence: 0,
        eventType: "imported",
        actor: parsedActor,
        occurredAt,
        previousEventSha256: null,
        manifestObjectSha256: manifestObject.sha256,
        manifestSha256: validation.manifestSha256,
        validationObjectSha256: validationObject.sha256,
        originalUploadSha256,
        importReceiptObjectSha256: receiptObject.sha256
      });
      const storedEvent = await this.#evidence.putDashboardTemplateEvent(event);
      const state: DashboardTemplateState = {
        integrity: "verified",
        manifest,
        validation,
        manifestObjectSha256: manifestObject.sha256,
        validationObjectSha256: validationObject.sha256,
        currentRevision: 0,
        lastEventSha256: storedEvent.sha256,
        activeRevisionNumber: null,
        revisions: new Map()
      };
      this.#templates.set(templateId, state);
      return DashboardImportResponseSchema.parse({
        template: this.#summary(state),
        receipt,
        diagnostics: validation.diagnostics
      });
    });
  }

  async updateDraft(
    templateId: string,
    input: DashboardDraftUpdateRequest
  ): Promise<DashboardDraftUpdateResponse> {
    const request = DashboardDraftUpdateRequestSchema.parse(input);
    if (request.manifest.template.templateId !== templateId) {
      throw new DashboardBuilderError(
        "invalid-dashboard-request",
        "The manifest template identifier must match the request path."
      );
    }
    return this.#serialize(templateId, async () => {
      const state = this.#requireTemplate(templateId);
      this.#assertRevision(state, request.expectedRevision);
      const validation = validateDashboardManifest(request.manifest);
      if (!validation.valid || validation.normalizedManifest === null) {
        throw new DashboardBuilderError(
          "dashboard-validation-failed",
          "The dashboard draft failed manifest validation."
        );
      }
      const manifestObject = await this.#evidence.putObject(
        validation.normalizedManifest
      );
      const validationObject = await this.#evidence.putObject(validation);
      const sequence = state.currentRevision + 1;
      const event = DashboardTemplateEventSchema.parse({
        schemaVersion: "dashboard-template-event/v1",
        eventId: safeId("dashboard-event", {
          templateId,
          sequence,
          eventType: "draft-updated",
          manifestSha256: validation.manifestSha256
        }),
        templateId,
        sequence,
        eventType: "draft-updated",
        actor: request.actor,
        occurredAt: this.#now(),
        previousEventSha256: state.lastEventSha256,
        manifestObjectSha256: manifestObject.sha256,
        manifestSha256: validation.manifestSha256,
        validationObjectSha256: validationObject.sha256
      });
      const storedEvent = await this.#evidence.putDashboardTemplateEvent(event);
      state.manifest = validation.normalizedManifest;
      state.validation = validation;
      state.manifestObjectSha256 = manifestObject.sha256;
      state.validationObjectSha256 = validationObject.sha256;
      state.currentRevision = sequence;
      state.lastEventSha256 = storedEvent.sha256;
      return DashboardDraftUpdateResponseSchema.parse({
        template: this.#summary(state),
        manifest: state.manifest,
        validation: state.validation
      });
    });
  }

  async preview(input: DashboardPreviewRequest): Promise<DashboardPreviewResponse> {
    const request = DashboardPreviewRequestSchema.parse(input);
    const state = this.#requireTemplate(request.manifest.template.templateId);
    if (!sameCanonical(request.manifest, state.manifest)) {
      throw new DashboardBuilderError(
        "revision-conflict",
        "Save the dashboard draft before requesting a preview.",
        {
          details: {
            templateId: state.manifest.template.templateId,
            currentRevision: state.currentRevision
          }
        }
      );
    }
    const validation = validateDashboardManifest(request.manifest);
    if (!validation.valid) {
      throw new DashboardBuilderError(
        "dashboard-validation-failed",
        "The dashboard preview failed manifest validation."
      );
    }
    return this.#runPreview(
      request,
      state.validationObjectSha256,
      state.currentRevision
    );
  }

  async publish(
    templateId: string,
    input: DashboardPublishRequest
  ): Promise<DashboardPublishResponse> {
    const request = DashboardPublishRequestSchema.parse(input);
    return this.#serialize(templateId, async () => {
      const state = this.#requireTemplate(templateId);
      this.#assertRevision(state, request.expectedRevision);
      if (!state.validation.publishEligible) {
        throw new DashboardBuilderError(
          "dashboard-validation-failed",
          "The dashboard draft is not eligible to publish."
        );
      }
      if (state.activeRevisionNumber !== null) {
        const active = state.revisions.get(state.activeRevisionNumber);
        if (
          active !== undefined &&
          active.summary.manifestSha256 === state.validation.manifestSha256
        ) {
          return DashboardPublishResponseSchema.parse({
            template: this.#summary(state),
            revision: active.summary,
            receipt: active.receipt,
            idempotent: true
          });
        }
      }
      const preview = await this.#runPreview(
        this.#defaultPreviewRequest(state.manifest),
        state.validationObjectSha256,
        state.currentRevision
      );
      const receipt = await this.#evidence.readDashboardBuildReceipt(preview.buildId);
      if (receipt.status !== "succeeded") {
        throw new DashboardBuilderError(
          "adapter-unavailable",
          "The dashboard preview did not produce a publishable build."
        );
      }
      const receiptObject = await this.#evidence.putObject(receipt);
      const sequence = state.currentRevision + 1;
      const revisionNumber = state.revisions.size + 1;
      const event = DashboardTemplateEventSchema.parse({
        schemaVersion: "dashboard-template-event/v1",
        eventId: safeId("dashboard-event", {
          templateId,
          sequence,
          eventType: "published",
          manifestSha256: state.validation.manifestSha256
        }),
        templateId,
        sequence,
        eventType: "published",
        actor: request.actor,
        occurredAt: this.#now(),
        previousEventSha256: state.lastEventSha256,
        manifestObjectSha256: state.manifestObjectSha256,
        manifestSha256: state.validation.manifestSha256,
        validationObjectSha256: state.validationObjectSha256,
        revisionNumber,
        buildId: preview.buildId,
        buildReceiptObjectSha256: receiptObject.sha256
      });
      const storedEvent = await this.#evidence.putDashboardTemplateEvent(event);
      const revision = this.#revisionFromEvent(event, state.manifest, receipt);
      state.currentRevision = sequence;
      state.lastEventSha256 = storedEvent.sha256;
      state.activeRevisionNumber = revisionNumber;
      state.revisions.set(revisionNumber, revision);
      return DashboardPublishResponseSchema.parse({
        template: this.#summary(state),
        revision: revision.summary,
        receipt,
        idempotent: false
      });
    });
  }

  async rollback(
    templateId: string,
    input: DashboardRollbackRequest
  ): Promise<DashboardRollbackResponse> {
    const request = DashboardRollbackRequestSchema.parse(input);
    return this.#serialize(templateId, async () => {
      const state = this.#requireTemplate(templateId);
      this.#assertRevision(state, request.expectedRevision);
      const target = state.revisions.get(request.targetRevisionNumber);
      if (target === undefined) {
        throw new DashboardBuilderError(
          "template-not-found",
          "The rollback target revision was not found."
        );
      }
      const validation = validateDashboardManifest(target.manifest);
      if (!validation.publishEligible || validation.normalizedManifest === null) {
        throw new DashboardBuilderError(
          "dashboard-validation-failed",
          "The rollback target is no longer publish eligible."
        );
      }
      const manifestObject = await this.#evidence.putObject(validation.normalizedManifest);
      const validationObject = await this.#evidence.putObject(validation);
      const preview = await this.#runPreview(
        this.#defaultPreviewRequest(validation.normalizedManifest),
        validationObject.sha256,
        state.currentRevision
      );
      const receipt = await this.#evidence.readDashboardBuildReceipt(preview.buildId);
      if (receipt.status !== "succeeded") {
        throw new DashboardBuilderError(
          "adapter-unavailable",
          "The rollback preview did not produce a publishable build."
        );
      }
      const receiptObject = await this.#evidence.putObject(receipt);
      const sequence = state.currentRevision + 1;
      const revisionNumber = state.revisions.size + 1;
      const event = DashboardTemplateEventSchema.parse({
        schemaVersion: "dashboard-template-event/v1",
        eventId: safeId("dashboard-event", {
          templateId,
          sequence,
          eventType: "rollback",
          targetRevisionNumber: request.targetRevisionNumber
        }),
        templateId,
        sequence,
        eventType: "rollback",
        actor: request.actor,
        occurredAt: this.#now(),
        previousEventSha256: state.lastEventSha256,
        manifestObjectSha256: manifestObject.sha256,
        manifestSha256: validation.manifestSha256,
        validationObjectSha256: validationObject.sha256,
        revisionNumber,
        targetRevisionNumber: request.targetRevisionNumber,
        buildId: preview.buildId,
        buildReceiptObjectSha256: receiptObject.sha256
      });
      const storedEvent = await this.#evidence.putDashboardTemplateEvent(event);
      const revision = this.#revisionFromEvent(event, validation.normalizedManifest, receipt);
      state.manifest = validation.normalizedManifest;
      state.validation = validation;
      state.manifestObjectSha256 = manifestObject.sha256;
      state.validationObjectSha256 = validationObject.sha256;
      state.currentRevision = sequence;
      state.lastEventSha256 = storedEvent.sha256;
      state.activeRevisionNumber = revisionNumber;
      state.revisions.set(revisionNumber, revision);
      return DashboardRollbackResponseSchema.parse({
        template: this.#summary(state),
        revision: revision.summary,
        receipt
      });
    });
  }

  async #runPreview(
    request: DashboardPreviewRequest,
    validationObjectSha256: string,
    draftRevision: number
  ): Promise<DashboardPreviewResponse> {
    const rawResponse = await this.#adapters.preview(request);
    const expectedManifestSha256 = sha256Hex(canonicalJson(request.manifest));
    const components = new Map(
      request.manifest.components.map((component) => [component.componentId, component])
    );
    const seenComponents = new Set<string>();
    const projectionsMatch = rawResponse.projections.every((projection) => {
      const component = components.get(projection.componentId);
      if (
        component === undefined ||
        component.type !== projection.type ||
        seenComponents.has(projection.componentId)
      ) {
        return false;
      }
      seenComponents.add(projection.componentId);
      return true;
    });
    if (
      rawResponse.templateId !== request.manifest.template.templateId ||
      rawResponse.manifestSha256 !== expectedManifestSha256 ||
      rawResponse.adapterId !== request.adapterId ||
      !projectionsMatch ||
      seenComponents.size !== components.size
    ) {
      throw new DashboardBuilderError(
        "adapter-unavailable",
        "The dashboard adapter returned an inconsistent preview projection."
      );
    }
    const buildId = safeId("dashboard-build", {
      request,
      draftRevision,
      generatedAt: rawResponse.generatedAt,
      projections: rawResponse.projections,
      diagnostics: rawResponse.diagnostics
    });
    const response = DashboardPreviewResponseSchema.parse({
      ...rawResponse,
      buildId
    });
    const receipt = DashboardBuildReceiptSchema.parse({
      schemaVersion: "dashboard-build-receipt/v1",
      buildId,
      templateId: response.templateId,
      draftRevision,
      adapterId: response.adapterId,
      status:
        response.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
        response.projections.some((projection) => projection.status === "unavailable")
          ? "failed"
          : "succeeded",
      startedAt: response.generatedAt,
      completedAt: response.generatedAt,
      manifestSha256: response.manifestSha256,
      validationObjectSha256,
      componentCount: response.projections.length,
      rowCount: rowCount(response),
      diagnosticCodes: response.diagnostics.map((diagnostic) => diagnostic.code)
    });
    await this.#evidence.putDashboardBuildReceipt(receipt);
    await this.#evidence.putObject(receipt);
    return response;
  }

  #defaultPreviewRequest(manifest: DashboardManifest): DashboardPreviewRequest {
    return DashboardPreviewRequestSchema.parse({
      manifest,
      adapterId: manifest.runtime.preferredAdapter,
      parameterValues: Object.fromEntries(
        manifest.parameters.map((parameter) => [
          parameter.parameterId,
          parameter.defaultValue
        ])
      ),
      filters: [],
      sort: [],
      page: { offset: 0, limit: DASHBOARD_MAX_PREVIEW_ROWS }
    });
  }

  async #replayTemplate(
    templateId: string,
    events: DashboardTemplateEvent[]
  ): Promise<DashboardTemplateState> {
    let previousHash: string | null = null;
    let manifest: DashboardManifest | undefined;
    let validation: DashboardValidationResult | undefined;
    let manifestObjectSha256 = "";
    let validationObjectSha256 = "";
    let activeRevisionNumber: number | null = null;
    const revisions = new Map<number, DashboardRevisionState>();
    for (const [index, event] of events.entries()) {
      if (event.sequence !== index) {
        throw new Error("dashboard template event history has a gap or duplicate sequence");
      }
      if (event.previousEventSha256 !== previousHash) {
        throw new Error("dashboard template event hash chain is broken");
      }
      if (index === 0 && event.eventType !== "imported") {
        throw new Error("dashboard template history must begin with an import");
      }
      const loadedManifest = DashboardManifestSchema.parse(
        await this.#evidence.readObject(event.manifestObjectSha256)
      );
      const loadedValidation = DashboardValidationResultSchema.parse(
        await this.#evidence.readObject(event.validationObjectSha256)
      );
      const recalculatedValidation = validateDashboardManifest(loadedManifest);
      if (
        loadedManifest.template.templateId !== templateId ||
        sha256Hex(canonicalJson(loadedManifest)) !== event.manifestSha256 ||
        loadedValidation.manifestSha256 !== event.manifestSha256 ||
        !loadedValidation.valid ||
        loadedValidation.normalizedManifest === null ||
        !sameCanonical(loadedValidation.normalizedManifest, loadedManifest) ||
        !sameCanonical(loadedValidation, recalculatedValidation)
      ) {
        throw new Error("dashboard template event references inconsistent manifest evidence");
      }
      if (event.eventType === "imported") {
        const receiptObject = DashboardImportReceiptSchema.parse(
          await this.#evidence.readObject(event.importReceiptObjectSha256)
        );
        const namedReceipt = await this.#evidence.readDashboardImportReceipt(
          receiptObject.importId
        );
        if (
          !sameCanonical(receiptObject, namedReceipt) ||
          receiptObject.templateId !== templateId ||
          receiptObject.originalUploadSha256 !== event.originalUploadSha256 ||
          receiptObject.normalizedManifestSha256 !== event.manifestSha256
        ) {
          throw new Error("dashboard import receipt evidence is inconsistent");
        }
      }
      if (event.eventType === "published" || event.eventType === "rollback") {
        if (event.revisionNumber !== revisions.size + 1) {
          throw new Error("dashboard published revision history is not contiguous");
        }
        if (
          event.eventType === "rollback" &&
          !revisions.has(event.targetRevisionNumber)
        ) {
          throw new Error("dashboard rollback references an unknown revision");
        }
        if (
          event.eventType === "rollback" &&
          !sameCanonical(
            loadedManifest,
            revisions.get(event.targetRevisionNumber)?.manifest
          )
        ) {
          throw new Error("dashboard rollback manifest differs from its target revision");
        }
        const receiptObject = DashboardBuildReceiptSchema.parse(
          await this.#evidence.readObject(event.buildReceiptObjectSha256)
        );
        const namedReceipt = await this.#evidence.readDashboardBuildReceipt(
          event.buildId
        );
        if (
          !sameCanonical(receiptObject, namedReceipt) ||
          receiptObject.buildId !== event.buildId ||
          receiptObject.templateId !== templateId ||
          receiptObject.manifestSha256 !== event.manifestSha256 ||
          receiptObject.validationObjectSha256 !== event.validationObjectSha256 ||
          receiptObject.draftRevision !== event.sequence - 1
        ) {
          throw new Error("dashboard build receipt evidence is inconsistent");
        }
        const revision = this.#revisionFromEvent(event, loadedManifest, receiptObject);
        revisions.set(event.revisionNumber, revision);
        activeRevisionNumber = event.revisionNumber;
      }
      manifest = loadedManifest;
      validation = loadedValidation;
      manifestObjectSha256 = event.manifestObjectSha256;
      validationObjectSha256 = event.validationObjectSha256;
      previousHash = eventHash(event);
    }
    if (manifest === undefined || validation === undefined || previousHash === null) {
      throw new Error("dashboard template history did not resolve a draft");
    }
    return {
      integrity: "verified",
      manifest,
      validation,
      manifestObjectSha256,
      validationObjectSha256,
      currentRevision: events.length - 1,
      lastEventSha256: previousHash,
      activeRevisionNumber,
      revisions
    };
  }

  #revisionFromEvent(
    event: DashboardTemplateEvent,
    manifest: DashboardManifest,
    receipt: DashboardBuildReceipt
  ): DashboardRevisionState {
    if (event.eventType !== "published" && event.eventType !== "rollback") {
      throw new Error("only publish and rollback events create revisions");
    }
    const summary: DashboardRevisionSummary = {
      templateId: event.templateId,
      revisionNumber: event.revisionNumber,
      eventId: event.eventId,
      eventType: event.eventType,
      sourceRevisionNumber:
        event.eventType === "rollback" ? event.targetRevisionNumber : null,
      manifestSha256: event.manifestSha256,
      actor: event.actor,
      occurredAt: event.occurredAt,
      buildId: event.buildId
    };
    return { summary, manifest, receipt };
  }

  #summary(state: StoredDashboardTemplateState): DashboardTemplateSummary {
    if (state.integrity === "blocked") {
      return DashboardTemplateSummarySchema.parse({
        templateId: state.templateId,
        name: state.templateId,
        currentRevision: 0,
        activeRevisionNumber: null,
        manifestSha256: "0".repeat(64),
        integrity: "blocked"
      });
    }
    return DashboardTemplateSummarySchema.parse({
      templateId: state.manifest.template.templateId,
      name: state.manifest.template.name,
      currentRevision: state.currentRevision,
      activeRevisionNumber: state.activeRevisionNumber,
      manifestSha256: state.validation.manifestSha256,
      integrity: "verified"
    });
  }

  #requireTemplate(templateId: string): DashboardTemplateState {
    this.#assertInitialized();
    const state = this.#templates.get(templateId);
    if (state === undefined) {
      throw new DashboardBuilderError(
        "template-not-found",
        "The requested dashboard template was not found."
      );
    }
    if (state.integrity === "blocked") {
      throw new DashboardBuilderError(
        "evidence-integrity-failed",
        "The dashboard template is blocked because its evidence failed verification."
      );
    }
    return state;
  }

  #assertRevision(state: DashboardTemplateState, expectedRevision: number): void {
    if (state.currentRevision !== expectedRevision) {
      throw new DashboardBuilderError(
        "revision-conflict",
        "The dashboard draft changed after it was loaded.",
        {
          details: {
            templateId: state.manifest.template.templateId,
            currentRevision: state.currentRevision
          }
        }
      );
    }
  }

  #assertInitialized(): void {
    if (!this.#initialized) {
      throw new Error("dashboard service must be initialized before use");
    }
  }

  async #serialize<T>(templateId: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#mutationQueues.get(templateId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = predecessor.then(() => gate);
    this.#mutationQueues.set(templateId, tail);
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.#mutationQueues.get(templateId) === tail) {
        this.#mutationQueues.delete(templateId);
      }
    }
  }
}
