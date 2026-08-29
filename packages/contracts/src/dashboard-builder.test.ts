import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_MAX_BINDINGS,
  DASHBOARD_MAX_CALCULATIONS,
  DASHBOARD_MAX_COMPONENTS,
  DASHBOARD_MAX_EXPRESSION_DEPTH,
  DASHBOARD_MAX_EXPRESSION_NODES,
  DASHBOARD_MAX_INTERACTIONS,
  DASHBOARD_MAX_PARAMETERS,
  DASHBOARD_MAX_UPLOAD_BYTES,
  DASHBOARD_SCHEMA_VERSION,
  DashboardAdapterStatusSchema,
  DashboardBuildReceiptSchema,
  DashboardDiagnosticSchema,
  DashboardDraftUpdateRequestSchema,
  DashboardExpressionSchema,
  DashboardFixtureDatasetSchema,
  DashboardImportRequestSchema,
  DashboardManifestSchema,
  DashboardPreviewRequestSchema,
  DashboardPreviewResponseSchema,
  DashboardPublishRequestSchema,
  DashboardRollbackRequestSchema,
  DashboardTemplateEventSchema,
  DashboardValidationResultSchema
} from "./dashboard-builder.js";

const sha = "a".repeat(64);
const occurredAt = "2026-08-29T16:00:00.000Z";

function manifest() {
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    template: {
      templateId: "sales-overview",
      name: "Sales overview",
      version: "1.0.0",
      description: "Synthetic sales dashboard."
    },
    provenance: { source: "native", sourceReference: null },
    runtime: { preferredAdapter: "fixture", fixtureId: "sales-overview-v1" },
    parameters: [
      {
        parameterId: "minimum-sales",
        label: "Minimum sales",
        type: "number",
        defaultValue: 0,
        minimum: 0,
        maximum: 1000000,
        affects: "data"
      }
    ],
    bindings: [
      {
        bindingId: "region",
        sourceField: "region",
        role: "dimension",
        valueType: "string",
        format: null,
        nullHandling: "exclude",
        qlik: null
      },
      {
        bindingId: "sales",
        sourceField: "sales",
        role: "measure-input",
        valueType: "number",
        format: "currency-usd",
        nullHandling: "zero",
        qlik: null
      }
    ],
    calculations: [
      {
        calculationId: "total-sales",
        label: "Total sales",
        kind: "portable",
        valueType: "number",
        format: "currency-usd",
        expression: {
          kind: "operation",
          operator: "sum",
          operands: [{ kind: "binding", bindingId: "sales" }]
        }
      }
    ],
    components: [
      {
        componentId: "sales-kpi",
        type: "kpi",
        title: "Sales",
        adapter: "preferred",
        emptyState: "No sales are available.",
        calculationId: "total-sales",
        format: "currency-usd"
      }
    ],
    interactions: [],
    theme: {
      surface: "#F2F5F7",
      text: "#132238",
      accent: "#1C4E80",
      success: "#2E7D5B",
      warning: "#E77C3C",
      fontScale: 1,
      spacing: "comfortable",
      radius: 8
    },
    layout: {
      columns: 12,
      large: [{ componentId: "sales-kpi", x: 0, y: 0, width: 4, height: 2 }],
      medium: [{ componentId: "sales-kpi", x: 0, y: 0, width: 6, height: 2 }],
      small: [{ componentId: "sales-kpi", x: 0, y: 0, width: 12, height: 2 }]
    }
  } as const;
}

function nestedExpression(depth: number): unknown {
  let expression: unknown = { kind: "literal", value: 1 };
  for (let index = 1; index < depth; index += 1) {
    expression = {
      kind: "operation",
      operator: "round",
      operands: [expression]
    };
  }
  return expression;
}

describe("dashboard manifest contracts", () => {
  it("strictly parses dashboard-template/v1 and rejects unknown executable fields", () => {
    const valid = manifest();
    expect(DashboardManifestSchema.parse(valid)).toEqual(valid);
    expect(DashboardImportRequestSchema.parse(valid)).toEqual(valid);

    expect(() =>
      DashboardManifestSchema.parse({ ...valid, jsx: "export default function App() {}" })
    ).toThrow();
    expect(() =>
      DashboardManifestSchema.parse({
        ...valid,
        components: [{ ...valid.components[0], html: "<script>alert(1)</script>" }]
      })
    ).toThrow();
    expect(() =>
      DashboardManifestSchema.parse({
        ...valid,
        components: [
          {
            componentId: "unsafe-text",
            type: "text",
            title: "Unsafe",
            adapter: "preferred",
            emptyState: "Nothing to show.",
            text: "<script>alert(1)</script>"
          }
        ]
      })
    ).toThrow(/HTML/u);
  });

  it("rejects unsupported versions, unsafe identifiers, and oversized strings", () => {
    const valid = manifest();
    expect(() =>
      DashboardManifestSchema.parse({ ...valid, schemaVersion: "dashboard-template/v2" })
    ).toThrow();
    expect(() =>
      DashboardManifestSchema.parse({
        ...valid,
        template: { ...valid.template, templateId: "../escape" }
      })
    ).toThrow();
    expect(() =>
      DashboardManifestSchema.parse({
        ...valid,
        template: { ...valid.template, description: "x".repeat(10_001) }
      })
    ).toThrow();
    expect(DASHBOARD_MAX_UPLOAD_BYTES).toBe(1_048_576);
  });

  it.each([
    ["parameters", DASHBOARD_MAX_PARAMETERS],
    ["bindings", DASHBOARD_MAX_BINDINGS],
    ["calculations", DASHBOARD_MAX_CALCULATIONS],
    ["components", DASHBOARD_MAX_COMPONENTS],
    ["interactions", DASHBOARD_MAX_INTERACTIONS]
  ] as const)("enforces the %s count bound", (field, maximum) => {
    const valid = manifest();
    const seed = valid[field][0] ?? {
      interactionId: "interaction-seed",
      type: "clear-filter",
      sourceComponentId: "sales-kpi",
      targetBindingId: "region"
    };
    const values = Array.from({ length: maximum + 1 }, (_, index) => {
      const suffix = String(index + 1);
      if (field === "parameters") {
        return { ...seed, parameterId: `parameter-${suffix}` };
      }
      if (field === "bindings") {
        return { ...seed, bindingId: `binding-${suffix}` };
      }
      if (field === "calculations") {
        return { ...seed, calculationId: `calculation-${suffix}` };
      }
      if (field === "components") {
        return { ...seed, componentId: `component-${suffix}` };
      }
      return { ...seed, interactionId: `interaction-${suffix}` };
    });

    expect(() => DashboardManifestSchema.parse({ ...valid, [field]: values })).toThrow();
  });

  it("bounds expression depth and total node count without an unbounded lazy schema", () => {
    expect(DashboardExpressionSchema.parse(nestedExpression(DASHBOARD_MAX_EXPRESSION_DEPTH)))
      .toBeDefined();
    expect(() =>
      DashboardExpressionSchema.parse(nestedExpression(DASHBOARD_MAX_EXPRESSION_DEPTH + 1))
    ).toThrow();

    const atLimit = {
      kind: "operation",
      operator: "coalesce",
      operands: Array.from(
        { length: DASHBOARD_MAX_EXPRESSION_NODES - 1 },
        () => ({ kind: "literal", value: 1 })
      )
    };
    expect(DashboardExpressionSchema.parse(atLimit)).toBeDefined();
    expect(() =>
      DashboardExpressionSchema.parse({
        ...atLimit,
        operands: [...atLimit.operands, { kind: "literal", value: 2 }]
      })
    ).toThrow(/node count/u);
  });
});

describe("dashboard service and API contracts", () => {
  it("validates diagnostics, adapter status, and normalized validation results", () => {
    const diagnostic = DashboardDiagnosticSchema.parse({
      severity: "warning",
      code: "layout-overlap",
      path: "/layout/large/1",
      message: "Two synthetic components overlap.",
      remediation: "Move one component.",
      componentId: "sales-kpi"
    });
    const adapter = DashboardAdapterStatusSchema.parse({
      adapterId: "fixture",
      label: "Synthetic fixture",
      status: "ready",
      capabilities: {
        portableCalculations: true,
        qlikCalculations: false,
        selections: true,
        paging: true
      },
      diagnostics: []
    });
    const validation = DashboardValidationResultSchema.parse({
      schemaVersion: "dashboard-validation/v1",
      valid: true,
      publishEligible: true,
      normalizedManifest: manifest(),
      manifestSha256: sha,
      diagnostics: [diagnostic]
    });

    expect(adapter.adapterId).toBe("fixture");
    expect(validation.normalizedManifest?.template.templateId).toBe("sales-overview");
  });

  it("validates preview requests and all six renderer projections", () => {
    const request = DashboardPreviewRequestSchema.parse({
      manifest: manifest(),
      adapterId: "fixture",
      parameterValues: { "minimum-sales": 100 },
      filters: [],
      sort: [],
      page: { offset: 0, limit: 100 }
    });
    const response = DashboardPreviewResponseSchema.parse({
      buildId: "dashboard-build-one",
      templateId: "sales-overview",
      manifestSha256: sha,
      adapterId: "fixture",
      generatedAt: occurredAt,
      projections: [
        {
          componentId: "kpi-one",
          type: "kpi",
          title: "Sales",
          status: "ready",
          diagnostics: [],
          value: 4200,
          formattedValue: "$4,200"
        },
        {
          componentId: "table-one",
          type: "data-table",
          title: "Rows",
          status: "ready",
          diagnostics: [],
          columns: [{ columnId: "region", header: "Region" }],
          rows: [
            {
              rowId: "row-one",
              cells: [{ columnId: "region", value: "North", formattedValue: "North" }]
            }
          ],
          totalRows: 1,
          offset: 0,
          limit: 100
        },
        {
          componentId: "bar-one",
          type: "bar-chart",
          title: "Sales by region",
          status: "ready",
          diagnostics: [],
          series: [
            {
              calculationId: "total-sales",
              label: "Sales",
              points: [{ dimension: "North", value: 4200, formattedValue: "$4,200" }]
            }
          ]
        },
        {
          componentId: "line-one",
          type: "line-chart",
          title: "Sales over time",
          status: "ready",
          diagnostics: [],
          series: [
            {
              calculationId: "total-sales",
              label: "Sales",
              points: [{ dimension: "2026-01", value: 4200, formattedValue: "$4,200" }]
            }
          ]
        },
        {
          componentId: "filter-one",
          type: "filter",
          title: "Region",
          status: "ready",
          diagnostics: [],
          bindingId: "region",
          options: [{ value: "North", label: "North", count: 1, selected: false }]
        },
        {
          componentId: "text-one",
          type: "text",
          title: "Notes",
          status: "ready",
          diagnostics: [],
          text: "Synthetic fixture preview."
        }
      ],
      diagnostics: []
    });

    expect(request.adapterId).toBe("fixture");
    expect(response.projections.map((projection) => projection.type)).toEqual([
      "kpi",
      "data-table",
      "bar-chart",
      "line-chart",
      "filter",
      "text"
    ]);
  });

  it("validates mutation requests and immutable lifecycle receipts", () => {
    expect(
      DashboardDraftUpdateRequestSchema.parse({
        expectedRevision: 1,
        actor: "local-operator",
        manifest: manifest()
      }).expectedRevision
    ).toBe(1);
    expect(
      DashboardPublishRequestSchema.parse({ expectedRevision: 2, actor: "local-operator" })
        .expectedRevision
    ).toBe(2);
    expect(
      DashboardRollbackRequestSchema.parse({
        expectedRevision: 3,
        targetRevisionNumber: 1,
        actor: "local-operator"
      }).targetRevisionNumber
    ).toBe(1);

    const event = DashboardTemplateEventSchema.parse({
      schemaVersion: "dashboard-template-event/v1",
      eventId: "dashboard-event-published-one",
      templateId: "sales-overview",
      sequence: 2,
      eventType: "published",
      actor: "local-operator",
      occurredAt,
      previousEventSha256: sha,
      manifestObjectSha256: sha,
      manifestSha256: sha,
      validationObjectSha256: sha,
      revisionNumber: 1,
      buildId: "dashboard-build-one",
      buildReceiptObjectSha256: sha
    });
    const receipt = DashboardBuildReceiptSchema.parse({
      schemaVersion: "dashboard-build-receipt/v1",
      buildId: "dashboard-build-one",
      templateId: "sales-overview",
      draftRevision: 2,
      adapterId: "fixture",
      status: "succeeded",
      startedAt: occurredAt,
      completedAt: occurredAt,
      manifestSha256: sha,
      validationObjectSha256: sha,
      componentCount: 6,
      rowCount: 8,
      diagnosticCodes: []
    });

    expect(event.eventType).toBe("published");
    expect(receipt.componentCount).toBe(6);
  });
});

describe("tracked dashboard fixtures", () => {
  it("parses the native sample and synthetic rows without real source references", async () => {
    const manifestPath = fileURLToPath(
      new URL("../../../sources/fixtures/dashboard-builder/sales-overview.manifest.json", import.meta.url)
    );
    const rowsPath = fileURLToPath(
      new URL(
        "../../../sources/fixtures/dashboard-builder/sales-overview.rows.synthetic.json",
        import.meta.url
      )
    );
    const sample = DashboardManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")) as unknown
    );
    const fixture = DashboardFixtureDatasetSchema.parse(
      JSON.parse(await readFile(rowsPath, "utf8")) as unknown
    );

    expect(sample.components.map((component) => component.type).sort()).toEqual([
      "bar-chart",
      "data-table",
      "filter",
      "kpi",
      "line-chart",
      "text"
    ]);
    expect(sample.provenance).toEqual({ source: "native", sourceReference: null });
    expect(sample.runtime).toEqual({
      preferredAdapter: "fixture",
      fixtureId: "sales-overview-v1"
    });
    expect(fixture.fixtureId).toBe(sample.runtime.fixtureId);
    expect(fixture.synthetic).toBe(true);
    expect(JSON.stringify({ sample, fixture })).not.toMatch(
      /(?:qlik|vizlib|tenant|password|secret|token|authorization|https?:\/\/)/iu
    );
  });
});
