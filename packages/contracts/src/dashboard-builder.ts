import { z } from "zod";
import { Sha256Schema, StableIdSchema, UtcTimestampSchema } from "./index.js";

export const DASHBOARD_SCHEMA_VERSION = "dashboard-template/v1" as const;
export const DASHBOARD_MAX_UPLOAD_BYTES = 1_048_576;
export const DASHBOARD_MAX_PARAMETERS = 100;
export const DASHBOARD_MAX_BINDINGS = 200;
export const DASHBOARD_MAX_CALCULATIONS = 200;
export const DASHBOARD_MAX_COMPONENTS = 100;
export const DASHBOARD_MAX_INTERACTIONS = 200;
export const DASHBOARD_MAX_EXPRESSION_DEPTH = 12;
export const DASHBOARD_MAX_EXPRESSION_NODES = 256;
export const DASHBOARD_MAX_PREVIEW_ROWS = 500;

const DashboardIdSchema = StableIdSchema.max(128);
const DashboardLabelSchema = z.string().trim().min(1).max(200);
const DashboardDescriptionSchema = z.string().max(10_000);
const DashboardFormatSchema = z.string().trim().min(1).max(100);
const DashboardDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const DashboardValueSchema = z.union([
  z.string().max(10_000),
  z.number().finite(),
  z.boolean(),
  z.null()
]);
const DashboardValueTypeSchema = z.enum(["string", "number", "boolean", "date"]);
const DashboardAdapterIdSchema = z.enum(["fixture", "qlik"]);
const DashboardComponentAdapterSchema = z.enum(["preferred", "fixture", "qlik"]);
const DashboardPlainTextSchema = z
  .string()
  .max(10_000)
  .refine((value) => !/<\/?[A-Za-z][^>]*>/u.test(value), "HTML markup is not allowed");
const DashboardSafeSourceIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/u, "expected a sanitized source identifier");

const DashboardTemplateIdentitySchema = z
  .object({
    templateId: DashboardIdSchema,
    name: DashboardLabelSchema,
    version: z
      .string()
      .max(64)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u),
    description: DashboardDescriptionSchema
  })
  .strict();

export const DashboardSourceReferenceSchema = z
  .object({
    tenantId: DashboardSafeSourceIdentifierSchema,
    appId: DashboardSafeSourceIdentifierSchema,
    objectId: DashboardSafeSourceIdentifierSchema
  })
  .strict();

const DashboardProvenanceSchema = z
  .object({
    source: z.enum(["native", "qlik-object-metadata"]),
    sourceReference: DashboardSourceReferenceSchema.nullable()
  })
  .strict()
  .superRefine((provenance, context) => {
    if (provenance.source === "native" && provenance.sourceReference !== null) {
      context.addIssue({
        code: "custom",
        message: "native provenance cannot contain an external source reference",
        path: ["sourceReference"]
      });
    }
    if (provenance.source === "qlik-object-metadata" && provenance.sourceReference === null) {
      context.addIssue({
        code: "custom",
        message: "Qlik metadata provenance requires a sanitized source reference",
        path: ["sourceReference"]
      });
    }
  });

const DashboardRuntimeSchema = z
  .object({
    preferredAdapter: DashboardAdapterIdSchema,
    fixtureId: DashboardIdSchema.nullable()
  })
  .strict()
  .superRefine((runtime, context) => {
    if (runtime.preferredAdapter === "fixture" && runtime.fixtureId === null) {
      context.addIssue({
        code: "custom",
        message: "fixture runtime requires a fixtureId",
        path: ["fixtureId"]
      });
    }
  });

const DashboardParameterBaseShape = {
  parameterId: DashboardIdSchema,
  label: DashboardLabelSchema,
  affects: z.enum(["data", "display", "both"])
};

export const DashboardParameterSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...DashboardParameterBaseShape,
      type: z.literal("string"),
      defaultValue: z.string().max(10_000)
    })
    .strict(),
  z
    .object({
      ...DashboardParameterBaseShape,
      type: z.literal("number"),
      defaultValue: z.number().finite(),
      minimum: z.number().finite().nullable(),
      maximum: z.number().finite().nullable()
    })
    .strict()
    .superRefine((parameter, context) => {
      if (
        parameter.minimum !== null &&
        parameter.maximum !== null &&
        parameter.minimum > parameter.maximum
      ) {
        context.addIssue({ code: "custom", message: "minimum cannot exceed maximum", path: ["minimum"] });
      }
    }),
  z
    .object({
      ...DashboardParameterBaseShape,
      type: z.literal("boolean"),
      defaultValue: z.boolean()
    })
    .strict(),
  z
    .object({
      ...DashboardParameterBaseShape,
      type: z.literal("date"),
      defaultValue: DashboardDateSchema,
      minimum: DashboardDateSchema.nullable(),
      maximum: DashboardDateSchema.nullable()
    })
    .strict(),
  z
    .object({
      ...DashboardParameterBaseShape,
      type: z.literal("enum"),
      defaultValue: z.string().max(500),
      choices: z.array(z.string().min(1).max(500)).min(1).max(100)
    })
    .strict()
]);

const DashboardQlikBindingSchema = z
  .object({
    fieldName: DashboardSafeSourceIdentifierSchema.nullable(),
    masterItemId: DashboardSafeSourceIdentifierSchema.nullable()
  })
  .strict();

export const DashboardBindingSchema = z
  .object({
    bindingId: DashboardIdSchema,
    sourceField: DashboardSafeSourceIdentifierSchema,
    role: z.enum(["dimension", "measure-input", "filter", "label"]),
    valueType: DashboardValueTypeSchema,
    format: DashboardFormatSchema.nullable(),
    nullHandling: z.enum(["exclude", "include", "zero", "empty"]),
    qlik: DashboardQlikBindingSchema.nullable().optional()
  })
  .strict();

export const DashboardPortableOperatorSchema = z.enum([
  "sum",
  "count",
  "min",
  "max",
  "average",
  "difference",
  "ratio",
  "multiply",
  "round",
  "coalesce"
]);

export type DashboardExpression =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "binding"; bindingId: string }
  | { kind: "parameter"; parameterId: string }
  | { kind: "calculation"; calculationId: string }
  | {
      kind: "operation";
      operator: z.infer<typeof DashboardPortableOperatorSchema>;
      operands: DashboardExpression[];
    };

const DashboardExpressionLeafSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: DashboardValueSchema }).strict(),
  z.object({ kind: z.literal("binding"), bindingId: DashboardIdSchema }).strict(),
  z.object({ kind: z.literal("parameter"), parameterId: DashboardIdSchema }).strict(),
  z.object({ kind: z.literal("calculation"), calculationId: DashboardIdSchema }).strict()
]);

function expressionSchemaAtDepth(depth: number): z.ZodType<DashboardExpression> {
  if (depth <= 1) {
    return DashboardExpressionLeafSchema as z.ZodType<DashboardExpression>;
  }
  const operation = z
    .object({
      kind: z.literal("operation"),
      operator: DashboardPortableOperatorSchema,
      operands: z
        .array(expressionSchemaAtDepth(depth - 1))
        .min(1)
        .max(DASHBOARD_MAX_EXPRESSION_NODES)
    })
    .strict();
  return z.union([
    DashboardExpressionLeafSchema,
    operation
  ]) as z.ZodType<DashboardExpression>;
}

function expressionNodeCount(expression: DashboardExpression): number {
  let count = 0;
  const pending: DashboardExpression[] = [expression];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    count += 1;
    if (current.kind === "operation") {
      pending.push(...current.operands);
    }
  }
  return count;
}

export const DashboardExpressionSchema = expressionSchemaAtDepth(
  DASHBOARD_MAX_EXPRESSION_DEPTH
).superRefine((expression, context) => {
  if (expressionNodeCount(expression) > DASHBOARD_MAX_EXPRESSION_NODES) {
    context.addIssue({
      code: "custom",
      message: `expression node count cannot exceed ${DASHBOARD_MAX_EXPRESSION_NODES}`
    });
  }
});

const DashboardCalculationBaseShape = {
  calculationId: DashboardIdSchema,
  label: DashboardLabelSchema,
  valueType: DashboardValueTypeSchema,
  format: DashboardFormatSchema.nullable()
};

export const DashboardCalculationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...DashboardCalculationBaseShape,
      kind: z.literal("portable"),
      expression: DashboardExpressionSchema
    })
    .strict(),
  z
    .object({
      ...DashboardCalculationBaseShape,
      kind: z.literal("qlik"),
      expression: z.string().trim().min(1).max(10_000)
    })
    .strict()
]);

const DashboardComponentBaseShape = {
  componentId: DashboardIdSchema,
  title: DashboardLabelSchema,
  adapter: DashboardComponentAdapterSchema,
  emptyState: z.string().max(500)
};

const DashboardComponentValueSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("binding"), id: DashboardIdSchema }).strict(),
  z.object({ kind: z.literal("calculation"), id: DashboardIdSchema }).strict()
]);

const DashboardTableColumnSchema = z
  .object({
    columnId: DashboardIdSchema,
    source: DashboardComponentValueSourceSchema,
    header: DashboardLabelSchema,
    alignment: z.enum(["start", "center", "end"]),
    width: z.number().int().min(1).max(1_000),
    sort: z.enum(["none", "ascending", "descending"]),
    totalBehavior: z.enum(["none", "sum", "average", "count"])
  })
  .strict();

const DashboardChartShape = {
  ...DashboardComponentBaseShape,
  dimensionBindingId: DashboardIdSchema,
  calculationIds: z.array(DashboardIdSchema).min(1).max(20),
  sort: z.enum(["dimension-ascending", "dimension-descending", "value-ascending", "value-descending"])
};

export const DashboardComponentSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...DashboardComponentBaseShape,
      type: z.literal("kpi"),
      calculationId: DashboardIdSchema,
      format: DashboardFormatSchema.nullable()
    })
    .strict(),
  z
    .object({
      ...DashboardComponentBaseShape,
      type: z.literal("data-table"),
      columns: z.array(DashboardTableColumnSchema).min(1).max(100),
      pageSize: z.number().int().min(1).max(100),
      selection: z.enum(["none", "single", "multiple"])
    })
    .strict(),
  z.object({ ...DashboardChartShape, type: z.literal("bar-chart") }).strict(),
  z.object({ ...DashboardChartShape, type: z.literal("line-chart") }).strict(),
  z
    .object({
      ...DashboardComponentBaseShape,
      type: z.literal("filter"),
      bindingId: DashboardIdSchema,
      multiSelect: z.boolean()
    })
    .strict(),
  z
    .object({
      ...DashboardComponentBaseShape,
      type: z.literal("text"),
      text: DashboardPlainTextSchema
    })
    .strict()
]);

export const DashboardInteractionSchema = z.discriminatedUnion("type", [
  z
    .object({
      interactionId: DashboardIdSchema,
      type: z.literal("set-filter"),
      sourceComponentId: DashboardIdSchema,
      targetBindingId: DashboardIdSchema
    })
    .strict(),
  z
    .object({
      interactionId: DashboardIdSchema,
      type: z.literal("clear-filter"),
      sourceComponentId: DashboardIdSchema,
      targetBindingId: DashboardIdSchema
    })
    .strict(),
  z
    .object({
      interactionId: DashboardIdSchema,
      type: z.literal("select-row"),
      sourceComponentId: DashboardIdSchema,
      targetComponentId: DashboardIdSchema
    })
    .strict(),
  z
    .object({
      interactionId: DashboardIdSchema,
      type: z.literal("select-chart-value"),
      sourceComponentId: DashboardIdSchema,
      targetComponentId: DashboardIdSchema,
      targetBindingId: DashboardIdSchema
    })
    .strict(),
  z
    .object({
      interactionId: DashboardIdSchema,
      type: z.literal("navigate-section"),
      sourceComponentId: DashboardIdSchema,
      targetComponentId: DashboardIdSchema
    })
    .strict()
]);

const DashboardThemeColorSchema = z.string().regex(/^#[A-Fa-f0-9]{6}$/u);
export const DashboardThemeSchema = z
  .object({
    surface: DashboardThemeColorSchema,
    text: DashboardThemeColorSchema,
    accent: DashboardThemeColorSchema,
    success: DashboardThemeColorSchema,
    warning: DashboardThemeColorSchema,
    fontScale: z.number().finite().min(0.75).max(1.5),
    spacing: z.enum(["compact", "comfortable", "spacious"]),
    radius: z.number().int().min(0).max(24)
  })
  .strict();

export const DashboardLayoutItemSchema = z
  .object({
    componentId: DashboardIdSchema,
    x: z.number().int().nonnegative().max(11),
    y: z.number().int().nonnegative().max(10_000),
    width: z.number().int().min(1).max(12),
    height: z.number().int().min(1).max(100)
  })
  .strict();

export const DashboardLayoutSchema = z
  .object({
    columns: z.literal(12),
    large: z.array(DashboardLayoutItemSchema).max(DASHBOARD_MAX_COMPONENTS),
    medium: z.array(DashboardLayoutItemSchema).max(DASHBOARD_MAX_COMPONENTS),
    small: z.array(DashboardLayoutItemSchema).max(DASHBOARD_MAX_COMPONENTS)
  })
  .strict();

export const DashboardManifestSchema = z
  .object({
    schemaVersion: z.literal(DASHBOARD_SCHEMA_VERSION),
    template: DashboardTemplateIdentitySchema,
    provenance: DashboardProvenanceSchema,
    runtime: DashboardRuntimeSchema,
    parameters: z.array(DashboardParameterSchema).max(DASHBOARD_MAX_PARAMETERS),
    bindings: z.array(DashboardBindingSchema).max(DASHBOARD_MAX_BINDINGS),
    calculations: z.array(DashboardCalculationSchema).max(DASHBOARD_MAX_CALCULATIONS),
    components: z.array(DashboardComponentSchema).max(DASHBOARD_MAX_COMPONENTS),
    interactions: z.array(DashboardInteractionSchema).max(DASHBOARD_MAX_INTERACTIONS),
    theme: DashboardThemeSchema,
    layout: DashboardLayoutSchema
  })
  .strict();

export type DashboardManifest = z.infer<typeof DashboardManifestSchema>;

export const DashboardDiagnosticSchema = z
  .object({
    severity: z.enum(["error", "warning", "info"]),
    code: DashboardIdSchema,
    path: z.string().max(2_000).regex(/^(?:\/(?:[^~/]|~0|~1)*)*$/u),
    message: z.string().min(1).max(2_000),
    remediation: z.string().min(1).max(2_000).optional(),
    componentId: DashboardIdSchema.optional(),
    calculationId: DashboardIdSchema.optional(),
    bindingId: DashboardIdSchema.optional()
  })
  .strict();

export type DashboardDiagnostic = z.infer<typeof DashboardDiagnosticSchema>;

export const DashboardValidationResultSchema = z
  .object({
    schemaVersion: z.literal("dashboard-validation/v1"),
    valid: z.boolean(),
    publishEligible: z.boolean(),
    normalizedManifest: DashboardManifestSchema.nullable(),
    manifestSha256: Sha256Schema.nullable(),
    diagnostics: z.array(DashboardDiagnosticSchema).max(1_000)
  })
  .strict()
  .superRefine((result, context) => {
    if (result.valid !== (result.normalizedManifest !== null && result.manifestSha256 !== null)) {
      context.addIssue({
        code: "custom",
        message: "valid results require a normalized manifest and manifest hash",
        path: ["valid"]
      });
    }
    if (!result.valid && result.publishEligible) {
      context.addIssue({
        code: "custom",
        message: "invalid results cannot be publish eligible",
        path: ["publishEligible"]
      });
    }
  });

export type DashboardValidationResult = z.infer<typeof DashboardValidationResultSchema>;

export const DashboardAdapterStatusSchema = z
  .object({
    adapterId: DashboardAdapterIdSchema,
    label: DashboardLabelSchema,
    status: z.enum(["ready", "unavailable", "unauthorized", "degraded"]),
    capabilities: z
      .object({
        portableCalculations: z.boolean(),
        qlikCalculations: z.boolean(),
        selections: z.boolean(),
        paging: z.boolean()
      })
      .strict(),
    diagnostics: z.array(DashboardDiagnosticSchema).max(100)
  })
  .strict();

export type DashboardAdapterStatus = z.infer<typeof DashboardAdapterStatusSchema>;

const DashboardParameterValuesSchema = z
  .record(DashboardIdSchema, DashboardValueSchema)
  .superRefine((values, context) => {
    if (Object.keys(values).length > DASHBOARD_MAX_PARAMETERS) {
      context.addIssue({ code: "custom", message: "too many parameter values" });
    }
  });

export const DashboardPreviewFilterSchema = z
  .object({
    bindingId: DashboardIdSchema,
    operator: z.enum(["equals", "not-equals", "in", "not-in", "greater-than", "less-than"]),
    value: z.union([DashboardValueSchema, z.array(DashboardValueSchema).min(1).max(100)])
  })
  .strict();

export const DashboardPreviewSortSchema = z
  .object({
    source: DashboardComponentValueSourceSchema,
    direction: z.enum(["ascending", "descending"])
  })
  .strict();

export const DashboardPreviewRequestSchema = z
  .object({
    manifest: DashboardManifestSchema,
    adapterId: DashboardAdapterIdSchema,
    parameterValues: DashboardParameterValuesSchema,
    filters: z.array(DashboardPreviewFilterSchema).max(100),
    sort: z.array(DashboardPreviewSortSchema).max(20),
    page: z
      .object({
        offset: z.number().int().nonnegative().max(1_000_000),
        limit: z.number().int().min(1).max(DASHBOARD_MAX_PREVIEW_ROWS)
      })
      .strict()
  })
  .strict();

export type DashboardPreviewRequest = z.infer<typeof DashboardPreviewRequestSchema>;

const DashboardProjectionBaseShape = {
  componentId: DashboardIdSchema,
  title: DashboardLabelSchema,
  status: z.enum(["ready", "empty", "unavailable"]),
  diagnostics: z.array(DashboardDiagnosticSchema).max(100)
};

const DashboardKpiProjectionSchema = z
  .object({
    ...DashboardProjectionBaseShape,
    type: z.literal("kpi"),
    value: DashboardValueSchema,
    formattedValue: z.string().max(1_000)
  })
  .strict();

const DashboardTableProjectionSchema = z
  .object({
    ...DashboardProjectionBaseShape,
    type: z.literal("data-table"),
    columns: z
      .array(z.object({ columnId: DashboardIdSchema, header: DashboardLabelSchema }).strict())
      .max(100),
    rows: z
      .array(
        z
          .object({
            rowId: DashboardIdSchema,
            cells: z
              .array(
                z
                  .object({
                    columnId: DashboardIdSchema,
                    value: DashboardValueSchema,
                    formattedValue: z.string().max(1_000)
                  })
                  .strict()
              )
              .max(100)
          })
          .strict()
      )
      .max(DASHBOARD_MAX_PREVIEW_ROWS),
    totalRows: z.number().int().nonnegative().max(1_000_000),
    offset: z.number().int().nonnegative().max(1_000_000),
    limit: z.number().int().min(1).max(DASHBOARD_MAX_PREVIEW_ROWS)
  })
  .strict();

const DashboardChartSeriesSchema = z
  .object({
    calculationId: DashboardIdSchema,
    label: DashboardLabelSchema,
    points: z
      .array(
        z
          .object({
            dimension: DashboardValueSchema,
            value: z.number().finite().nullable(),
            formattedValue: z.string().max(1_000)
          })
          .strict()
      )
      .max(DASHBOARD_MAX_PREVIEW_ROWS)
  })
  .strict();

const DashboardBarChartProjectionSchema = z
  .object({
    ...DashboardProjectionBaseShape,
    type: z.literal("bar-chart"),
    series: z.array(DashboardChartSeriesSchema).max(20)
  })
  .strict();

const DashboardLineChartProjectionSchema = z
  .object({
    ...DashboardProjectionBaseShape,
    type: z.literal("line-chart"),
    series: z.array(DashboardChartSeriesSchema).max(20)
  })
  .strict();

const DashboardFilterProjectionSchema = z
  .object({
    ...DashboardProjectionBaseShape,
    type: z.literal("filter"),
    bindingId: DashboardIdSchema,
    options: z
      .array(
        z
          .object({
            value: DashboardValueSchema,
            label: z.string().max(1_000),
            count: z.number().int().nonnegative().max(1_000_000),
            selected: z.boolean()
          })
          .strict()
      )
      .max(DASHBOARD_MAX_PREVIEW_ROWS)
  })
  .strict();

const DashboardTextProjectionSchema = z
  .object({
    ...DashboardProjectionBaseShape,
    type: z.literal("text"),
    text: DashboardPlainTextSchema
  })
  .strict();

export const DashboardComponentProjectionSchema = z.discriminatedUnion("type", [
  DashboardKpiProjectionSchema,
  DashboardTableProjectionSchema,
  DashboardBarChartProjectionSchema,
  DashboardLineChartProjectionSchema,
  DashboardFilterProjectionSchema,
  DashboardTextProjectionSchema
]);

export const DashboardPreviewResponseSchema = z
  .object({
    buildId: DashboardIdSchema,
    templateId: DashboardIdSchema,
    manifestSha256: Sha256Schema,
    adapterId: DashboardAdapterIdSchema,
    generatedAt: UtcTimestampSchema,
    projections: z.array(DashboardComponentProjectionSchema).max(DASHBOARD_MAX_COMPONENTS),
    diagnostics: z.array(DashboardDiagnosticSchema).max(1_000)
  })
  .strict();

export type DashboardPreviewResponse = z.infer<typeof DashboardPreviewResponseSchema>;

const DashboardEventBaseShape = {
  schemaVersion: z.literal("dashboard-template-event/v1"),
  eventId: DashboardIdSchema,
  templateId: DashboardIdSchema,
  sequence: z.number().int().nonnegative(),
  actor: DashboardIdSchema,
  occurredAt: UtcTimestampSchema,
  previousEventSha256: Sha256Schema.nullable(),
  manifestObjectSha256: Sha256Schema,
  manifestSha256: Sha256Schema,
  validationObjectSha256: Sha256Schema
};

export const DashboardTemplateEventSchema = z
  .discriminatedUnion("eventType", [
    z
      .object({
        ...DashboardEventBaseShape,
        eventType: z.literal("imported"),
        originalUploadSha256: Sha256Schema,
        importReceiptObjectSha256: Sha256Schema
      })
      .strict(),
    z.object({ ...DashboardEventBaseShape, eventType: z.literal("draft-updated") }).strict(),
    z
      .object({
        ...DashboardEventBaseShape,
        eventType: z.literal("published"),
        revisionNumber: z.number().int().positive(),
        buildId: DashboardIdSchema,
        buildReceiptObjectSha256: Sha256Schema
      })
      .strict(),
    z
      .object({
        ...DashboardEventBaseShape,
        eventType: z.literal("rollback"),
        revisionNumber: z.number().int().positive(),
        targetRevisionNumber: z.number().int().positive(),
        buildId: DashboardIdSchema,
        buildReceiptObjectSha256: Sha256Schema
      })
      .strict()
  ])
  .superRefine((event, context) => {
    if ((event.sequence === 0) !== (event.previousEventSha256 === null)) {
      context.addIssue({
        code: "custom",
        message: "only the first event can omit the previous event hash",
        path: ["previousEventSha256"]
      });
    }
    if (event.eventType === "imported" && event.sequence !== 0) {
      context.addIssue({ code: "custom", message: "an import must be the first event", path: ["sequence"] });
    }
  });

export type DashboardTemplateEvent = z.infer<typeof DashboardTemplateEventSchema>;

export const DashboardBuildReceiptSchema = z
  .object({
    schemaVersion: z.literal("dashboard-build-receipt/v1"),
    buildId: DashboardIdSchema,
    templateId: DashboardIdSchema,
    draftRevision: z.number().int().nonnegative(),
    adapterId: DashboardAdapterIdSchema,
    status: z.enum(["succeeded", "failed"]),
    startedAt: UtcTimestampSchema,
    completedAt: UtcTimestampSchema,
    manifestSha256: Sha256Schema,
    validationObjectSha256: Sha256Schema,
    componentCount: z.number().int().nonnegative().max(DASHBOARD_MAX_COMPONENTS),
    rowCount: z.number().int().nonnegative().max(1_000_000),
    diagnosticCodes: z.array(DashboardIdSchema).max(1_000)
  })
  .strict()
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
      context.addIssue({ code: "custom", message: "completedAt cannot precede startedAt", path: ["completedAt"] });
    }
  });

export type DashboardBuildReceipt = z.infer<typeof DashboardBuildReceiptSchema>;

export const DashboardImportReceiptSchema = z
  .object({
    schemaVersion: z.literal("dashboard-import-receipt/v1"),
    importId: DashboardIdSchema,
    templateId: DashboardIdSchema,
    actor: DashboardIdSchema,
    occurredAt: UtcTimestampSchema,
    uploadBytes: z.number().int().positive().max(DASHBOARD_MAX_UPLOAD_BYTES),
    originalUploadSha256: Sha256Schema,
    normalizedManifestSha256: Sha256Schema,
    diagnosticCodes: z.array(DashboardIdSchema).max(1_000)
  })
  .strict();

export type DashboardImportReceipt = z.infer<typeof DashboardImportReceiptSchema>;

export const DashboardImportRequestSchema = DashboardManifestSchema;
export type DashboardImportRequest = DashboardManifest;

export const DashboardDraftUpdateRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    actor: DashboardIdSchema,
    manifest: DashboardManifestSchema
  })
  .strict();
export type DashboardDraftUpdateRequest = z.infer<typeof DashboardDraftUpdateRequestSchema>;

export const DashboardValidateRequestSchema = z
  .object({
    manifest: DashboardManifestSchema,
    mode: z.enum(["draft", "publish"])
  })
  .strict();
export type DashboardValidateRequest = z.infer<typeof DashboardValidateRequestSchema>;

export const DashboardPublishRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    actor: DashboardIdSchema
  })
  .strict();
export type DashboardPublishRequest = z.infer<typeof DashboardPublishRequestSchema>;

export const DashboardRollbackRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    targetRevisionNumber: z.number().int().positive(),
    actor: DashboardIdSchema
  })
  .strict();
export type DashboardRollbackRequest = z.infer<typeof DashboardRollbackRequestSchema>;

export const DashboardTemplateSummarySchema = z
  .object({
    templateId: DashboardIdSchema,
    name: DashboardLabelSchema,
    currentRevision: z.number().int().nonnegative(),
    activeRevisionNumber: z.number().int().positive().nullable(),
    manifestSha256: Sha256Schema,
    integrity: z.enum(["verified", "blocked"])
  })
  .strict();
export type DashboardTemplateSummary = z.infer<typeof DashboardTemplateSummarySchema>;

export const DashboardRevisionSummarySchema = z
  .object({
    templateId: DashboardIdSchema,
    revisionNumber: z.number().int().positive(),
    eventId: DashboardIdSchema,
    eventType: z.enum(["published", "rollback"]),
    sourceRevisionNumber: z.number().int().positive().nullable(),
    manifestSha256: Sha256Schema,
    actor: DashboardIdSchema,
    occurredAt: UtcTimestampSchema,
    buildId: DashboardIdSchema
  })
  .strict();
export type DashboardRevisionSummary = z.infer<typeof DashboardRevisionSummarySchema>;

export const DashboardImportResponseSchema = z
  .object({
    template: DashboardTemplateSummarySchema,
    receipt: DashboardImportReceiptSchema,
    diagnostics: z.array(DashboardDiagnosticSchema).max(1_000)
  })
  .strict();
export type DashboardImportResponse = z.infer<typeof DashboardImportResponseSchema>;

export const DashboardTemplateListResponseSchema = z
  .object({ items: z.array(DashboardTemplateSummarySchema).max(1_000) })
  .strict();
export type DashboardTemplateListResponse = z.infer<typeof DashboardTemplateListResponseSchema>;

export const DashboardTemplateResponseSchema = z
  .object({
    template: DashboardTemplateSummarySchema,
    manifest: DashboardManifestSchema,
    validation: DashboardValidationResultSchema
  })
  .strict();
export type DashboardTemplateResponse = z.infer<typeof DashboardTemplateResponseSchema>;
export const DashboardDraftUpdateResponseSchema = DashboardTemplateResponseSchema;
export type DashboardDraftUpdateResponse = DashboardTemplateResponse;

export const DashboardRevisionListResponseSchema = z
  .object({ items: z.array(DashboardRevisionSummarySchema).max(10_000) })
  .strict();
export type DashboardRevisionListResponse = z.infer<typeof DashboardRevisionListResponseSchema>;

export const DashboardRevisionResponseSchema = z
  .object({
    revision: DashboardRevisionSummarySchema,
    manifest: DashboardManifestSchema
  })
  .strict();
export type DashboardRevisionResponse = z.infer<typeof DashboardRevisionResponseSchema>;

export const DashboardPublishResponseSchema = z
  .object({
    template: DashboardTemplateSummarySchema,
    revision: DashboardRevisionSummarySchema,
    receipt: DashboardBuildReceiptSchema,
    idempotent: z.boolean()
  })
  .strict();
export type DashboardPublishResponse = z.infer<typeof DashboardPublishResponseSchema>;

export const DashboardRollbackResponseSchema = z
  .object({
    template: DashboardTemplateSummarySchema,
    revision: DashboardRevisionSummarySchema,
    receipt: DashboardBuildReceiptSchema
  })
  .strict();
export type DashboardRollbackResponse = z.infer<typeof DashboardRollbackResponseSchema>;

export const DashboardAdaptersResponseSchema = z
  .object({ items: z.array(DashboardAdapterStatusSchema).length(2) })
  .strict();
export type DashboardAdaptersResponse = z.infer<typeof DashboardAdaptersResponseSchema>;

export const DashboardApiErrorCodeSchema = z.enum([
  "dashboard-validation-failed",
  "revision-conflict",
  "adapter-unavailable",
  "evidence-integrity-failed",
  "unsupported-schema-version"
]);

export const DashboardConflictDetailsSchema = z
  .object({
    templateId: DashboardIdSchema,
    currentRevision: z.number().int().nonnegative()
  })
  .strict();
export type DashboardConflictDetails = z.infer<typeof DashboardConflictDetailsSchema>;

export const DashboardErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: DashboardApiErrorCodeSchema,
        message: z.string().min(1).max(500),
        retryable: z.boolean(),
        details: DashboardConflictDetailsSchema.nullable()
      })
      .strict()
  })
  .strict();
export type DashboardErrorEnvelope = z.infer<typeof DashboardErrorEnvelopeSchema>;

const DashboardFixtureFieldSchema = z
  .object({
    fieldId: DashboardIdSchema,
    valueType: DashboardValueTypeSchema
  })
  .strict();

const DashboardFixtureRowSchema = z.record(DashboardIdSchema, DashboardValueSchema);

export const DashboardFixtureDatasetSchema = z
  .object({
    schemaVersion: z.literal("dashboard-fixture/v1"),
    fixtureId: DashboardIdSchema,
    synthetic: z.literal(true),
    fields: z.array(DashboardFixtureFieldSchema).min(1).max(DASHBOARD_MAX_BINDINGS),
    rows: z.array(DashboardFixtureRowSchema).min(1).max(10_000)
  })
  .strict();

export type DashboardFixtureDataset = z.infer<typeof DashboardFixtureDatasetSchema>;
