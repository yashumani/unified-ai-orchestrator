import { StableIdSchema } from "@unified-ai/contracts";
import {
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
  type DashboardAdapterStatus,
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
  type DashboardValidationResult
} from "@unified-ai/contracts/dashboard-builder";
import { DashboardBuilderError } from "@unified-ai/dashboard-builder";
import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";

const dashboardId = StableIdSchema.max(128);
const templateParameters = z.object({ templateId: dashboardId }).strict();
const buildParameters = z.object({ buildId: dashboardId }).strict();
const revisionParameters = z
  .object({
    templateId: dashboardId,
    revisionNumber: z
      .string()
      .regex(/^[1-9]\d{0,8}$/u)
      .transform((value) => Number(value))
  })
  .strict();

interface RuntimeSchema<T> {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false };
}

export interface DashboardBuilderRouteService {
  listTemplates(): DashboardTemplateListResponse;
  getTemplate(templateId: string): DashboardTemplateResponse;
  listRevisions(templateId: string): DashboardRevisionListResponse;
  getRevision(templateId: string, revisionNumber: number): DashboardRevisionResponse;
  getBuild(buildId: string): Promise<DashboardBuildReceipt>;
  listAdapterStatuses(): Promise<DashboardAdapterStatus[]>;
  validate(input: unknown): DashboardValidationResult;
  importManifest(uploadBytes: Uint8Array, actor: string): Promise<DashboardImportResponse>;
  updateDraft(
    templateId: string,
    input: DashboardDraftUpdateRequest
  ): Promise<DashboardDraftUpdateResponse>;
  preview(input: DashboardPreviewRequest): Promise<DashboardPreviewResponse>;
  publish(
    templateId: string,
    input: DashboardPublishRequest
  ): Promise<DashboardPublishResponse>;
  rollback(
    templateId: string,
    input: DashboardRollbackRequest
  ): Promise<DashboardRollbackResponse>;
}

export interface DashboardBuilderRouteContext {
  service: DashboardBuilderRouteService;
  sample: {
    manifest: DashboardManifest;
    manifestBytes: Uint8Array;
  };
}

function asyncRoute(
  handler: (
    request: Parameters<RequestHandler>[0],
    response: Parameters<RequestHandler>[1]
  ) => Promise<void>
): RequestHandler {
  return (request, response, next) => {
    void handler(request, response).catch(next);
  };
}

function responseValue<T>(schema: RuntimeSchema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DashboardBuilderError(
      "evidence-integrity-failed",
      "A dashboard response failed contract validation."
    );
  }
  return result.data;
}

function assertTemplateIdentity(templateId: string, manifest: DashboardManifest): void {
  if (manifest.template.templateId !== templateId) {
    throw new DashboardBuilderError(
      "invalid-dashboard-request",
      "The dashboard manifest identifier does not match the request path."
    );
  }
}

function attachment(response: Response, fileName: string): void {
  response.setHeader("content-disposition", `attachment; filename="${fileName}"`);
  response.setHeader("cache-control", "no-store");
}

export function createDashboardBuilderRouter(
  context: DashboardBuilderRouteContext
): Router {
  const router = Router();
  const sampleManifest = responseValue(DashboardManifestSchema, context.sample.manifest);
  const sampleBytes = Buffer.from(context.sample.manifestBytes);
  let parsedSampleBytes: DashboardManifest;
  try {
    parsedSampleBytes = responseValue(
      DashboardManifestSchema,
      JSON.parse(sampleBytes.toString("utf8")) as unknown
    );
  } catch {
    throw new DashboardBuilderError(
      "evidence-integrity-failed",
      "The tracked dashboard sample failed integrity verification."
    );
  }
  if (JSON.stringify(parsedSampleBytes) !== JSON.stringify(sampleManifest)) {
    throw new DashboardBuilderError(
      "evidence-integrity-failed",
      "The tracked dashboard sample failed integrity verification."
    );
  }

  router.get("/sample", (_request, response) => {
    attachment(
      response,
      `${sampleManifest.template.templateId}.dashboard.json`
    );
    response.type("application/json").send(sampleBytes);
  });

  router.post(
    "/imports",
    asyncRoute(async (request, response) => {
      if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
        throw new DashboardBuilderError(
          "invalid-dashboard-request",
          "The dashboard upload must contain JSON bytes."
        );
      }
      const result = await context.service.importManifest(
        new Uint8Array(request.body),
        "local-operator"
      );
      response.status(201).json(responseValue(DashboardImportResponseSchema, result));
    })
  );

  router.get("/templates", (_request, response) => {
    response.json(
      responseValue(
        DashboardTemplateListResponseSchema,
        context.service.listTemplates()
      )
    );
  });

  router.get("/templates/:templateId", (request, response) => {
    const { templateId } = templateParameters.parse(request.params);
    response.json(
      responseValue(
        DashboardTemplateResponseSchema,
        context.service.getTemplate(templateId)
      )
    );
  });

  router.get("/templates/:templateId/revisions", (request, response) => {
    const { templateId } = templateParameters.parse(request.params);
    response.json(
      responseValue(
        DashboardRevisionListResponseSchema,
        context.service.listRevisions(templateId)
      )
    );
  });

  router.get(
    "/templates/:templateId/revisions/:revisionNumber",
    (request, response) => {
      const { templateId, revisionNumber } = revisionParameters.parse(request.params);
      const result = responseValue(
        DashboardRevisionResponseSchema,
        context.service.getRevision(templateId, revisionNumber)
      );
      attachment(
        response,
        `${templateId}.revision-${String(revisionNumber)}.dashboard.json`
      );
      response.json(result);
    }
  );

  router.put(
    "/templates/:templateId/draft",
    asyncRoute(async (request, response) => {
      const { templateId } = templateParameters.parse(request.params);
      const body = DashboardDraftUpdateRequestSchema.parse(request.body);
      assertTemplateIdentity(templateId, body.manifest);
      const result = await context.service.updateDraft(templateId, body);
      response.json(responseValue(DashboardDraftUpdateResponseSchema, result));
    })
  );

  router.post(
    "/templates/:templateId/validate",
    asyncRoute(async (request, response) => {
      const { templateId } = templateParameters.parse(request.params);
      const body = DashboardValidateRequestSchema.parse(request.body);
      assertTemplateIdentity(templateId, body.manifest);
      const result = responseValue(
        DashboardValidationResultSchema,
        context.service.validate(body.manifest)
      );
      const acceptable =
        result.valid && (body.mode === "draft" || result.publishEligible);
      response.status(acceptable ? 200 : 422).json(result);
    })
  );

  router.post(
    "/templates/:templateId/preview",
    asyncRoute(async (request, response) => {
      const { templateId } = templateParameters.parse(request.params);
      const body = DashboardPreviewRequestSchema.parse(request.body);
      assertTemplateIdentity(templateId, body.manifest);
      const statuses = responseValue(DashboardAdaptersResponseSchema, {
        items: await context.service.listAdapterStatuses()
      });
      const selected = statuses.items.find(
        (adapter) => adapter.adapterId === body.adapterId
      );
      if (
        selected === undefined ||
        (selected.status !== "ready" && selected.status !== "degraded")
      ) {
        throw new DashboardBuilderError(
          "adapter-unavailable",
          "The requested dashboard adapter is unavailable.",
          { retryable: true }
        );
      }
      const result = await context.service.preview(body);
      response.json(responseValue(DashboardPreviewResponseSchema, result));
    })
  );

  router.post(
    "/templates/:templateId/publish",
    asyncRoute(async (request, response) => {
      const { templateId } = templateParameters.parse(request.params);
      const body = DashboardPublishRequestSchema.parse(request.body);
      const result = responseValue(
        DashboardPublishResponseSchema,
        await context.service.publish(templateId, body)
      );
      response.status(result.idempotent ? 200 : 201).json(result);
    })
  );

  router.post(
    "/templates/:templateId/rollback",
    asyncRoute(async (request, response) => {
      const { templateId } = templateParameters.parse(request.params);
      const body = DashboardRollbackRequestSchema.parse(request.body);
      const result = await context.service.rollback(templateId, body);
      response.status(201).json(responseValue(DashboardRollbackResponseSchema, result));
    })
  );

  router.get(
    "/builds/:buildId",
    asyncRoute(async (request, response) => {
      const { buildId } = buildParameters.parse(request.params);
      const result = await context.service.getBuild(buildId);
      response.json(responseValue(DashboardBuildReceiptSchema, result));
    })
  );

  router.get(
    "/adapters",
    asyncRoute(async (_request, response) => {
      response.json(
        responseValue(DashboardAdaptersResponseSchema, {
          items: await context.service.listAdapterStatuses()
        })
      );
    })
  );

  return router;
}
