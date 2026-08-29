import type {
  DashboardFixtureDataset,
  DashboardManifest,
  DashboardPreviewRequest
} from "@unified-ai/contracts/dashboard-builder";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { FixtureDashboardAdapter } from "./fixture-adapter.js";
import { loadDashboardSample } from "./sample-loader.js";

let manifest: DashboardManifest;
let fixture: DashboardFixtureDataset;

beforeAll(async () => {
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".."
  );
  const sample = await loadDashboardSample(repositoryRoot);
  manifest = sample.manifest;
  fixture = sample.fixture;
});

function request(
  overrides: Partial<DashboardPreviewRequest> = {}
): DashboardPreviewRequest {
  return {
    manifest,
    adapterId: "fixture",
    parameterValues: {},
    filters: [],
    sort: [],
    page: { offset: 0, limit: 50 },
    ...overrides
  };
}

function adapter(dataset: DashboardFixtureDataset = fixture): FixtureDashboardAdapter {
  return new FixtureDashboardAdapter(dataset, {
    now: () => new Date("2026-08-29T12:00:00.000Z")
  });
}

describe("fixture dashboard adapter", () => {
  it("reports a ready, credential-free portable capability surface", async () => {
    await expect(adapter().status()).resolves.toEqual({
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
    });
  });

  it("projects all six allowlisted component types from the tracked sample", async () => {
    const response = await adapter().preview(request());

    expect(response.adapterId).toBe("fixture");
    expect(response.generatedAt).toBe("2026-08-29T12:00:00.000Z");
    expect(response.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(response.buildId).toMatch(/^fixture-preview-[a-f0-9]{16}$/u);
    expect(response.projections.map((projection) => projection.type)).toEqual([
      "kpi",
      "data-table",
      "bar-chart",
      "line-chart",
      "filter",
      "text"
    ]);

    const kpi = response.projections.find((projection) => projection.type === "kpi");
    expect(kpi).toEqual(
      expect.objectContaining({
        status: "ready",
        value: 107_350,
        formattedValue: "$107,350"
      })
    );

    const bar = response.projections.find(
      (projection) => projection.type === "bar-chart"
    );
    expect(bar?.type === "bar-chart" ? bar.series[0]?.points : []).toEqual([
      expect.objectContaining({ dimension: "West", value: 29_300 }),
      expect.objectContaining({ dimension: "North", value: 29_200 }),
      expect.objectContaining({ dimension: "East", value: 25_850 }),
      expect.objectContaining({ dimension: "South", value: 23_000 })
    ]);

    const line = response.projections.find(
      (projection) => projection.type === "line-chart"
    );
    expect(line?.type === "line-chart" ? line.series[0]?.points[0] : undefined).toEqual(
      expect.objectContaining({ dimension: "2026-01-05", value: 12_800 })
    );

    const filter = response.projections.find(
      (projection) => projection.type === "filter"
    );
    expect(filter?.type === "filter" ? filter.options : []).toEqual([
      { value: "Direct", label: "Direct", count: 3, selected: false },
      { value: "Online", label: "Online", count: 3, selected: false },
      { value: "Partner", label: "Partner", count: 2, selected: false }
    ]);

    const text = response.projections.find((projection) => projection.type === "text");
    expect(text?.type === "text" ? text.text : "").toContain("Invented rows");
    expect(response.diagnostics).toEqual([]);
  });

  it("filters before grouping and marks matching filter options selected", async () => {
    const response = await adapter().preview(
      request({
        filters: [{ bindingId: "region", operator: "equals", value: "North" }]
      })
    );

    const kpi = response.projections.find((projection) => projection.type === "kpi");
    expect(kpi?.type === "kpi" ? kpi.value : null).toBe(29_200);

    const bar = response.projections.find(
      (projection) => projection.type === "bar-chart"
    );
    expect(bar?.type === "bar-chart" ? bar.series[0]?.points : []).toEqual([
      expect.objectContaining({ dimension: "North", value: 29_200 })
    ]);

    const regionManifest: DashboardManifest = {
      ...manifest,
      components: manifest.components.map((component) =>
        component.type === "filter" ? { ...component, bindingId: "region" } : component
      )
    };
    const regionResponse = await adapter().preview(
      request({
        manifest: regionManifest,
        filters: [{ bindingId: "region", operator: "in", value: ["North"] }]
      })
    );
    const filter = regionResponse.projections.find(
      (projection) => projection.type === "filter"
    );
    expect(filter?.type === "filter" ? filter.options : []).toEqual([
      { value: "North", label: "North", count: 2, selected: true }
    ]);
  });

  it("applies explicit stable sorting and bounded table paging", async () => {
    const response = await adapter().preview(
      request({
        sort: [
          {
            source: { kind: "binding", id: "sales" },
            direction: "descending"
          }
        ],
        page: { offset: 1, limit: 2 }
      })
    );
    const table = response.projections.find(
      (projection) => projection.type === "data-table"
    );
    if (table?.type !== "data-table") {
      throw new Error("expected a table projection");
    }

    expect(table.totalRows).toBe(8);
    expect(table.offset).toBe(1);
    expect(table.limit).toBe(2);
    expect(
      table.rows.map(
        (row) => row.cells.find((cell) => cell.columnId === "table-sales")?.value
      )
    ).toEqual([16_400, 15_750]);
  });

  it("keeps nulls last and original row order as the descending-sort tiebreaker", async () => {
    const tiedFixture: DashboardFixtureDataset = {
      ...fixture,
      rows: [
        { ...fixture.rows[0], region: "Same" },
        { ...fixture.rows[1], region: "Same" },
        { ...fixture.rows[2], region: null }
      ]
    };

    const response = await adapter(tiedFixture).preview(
      request({
        sort: [
          {
            source: { kind: "binding", id: "region" },
            direction: "descending"
          }
        ],
        page: { offset: 0, limit: 3 }
      })
    );
    const table = response.projections.find(
      (projection) => projection.type === "data-table"
    );

    expect(table?.type === "data-table" ? table.rows.map((row) => row.rowId) : []).toEqual([
      "fixture-row-1",
      "fixture-row-2",
      "fixture-row-3"
    ]);
  });

  it("supports all filter operators deterministically", async () => {
    const greater = await adapter().preview(
      request({
        filters: [{ bindingId: "sales", operator: "greater-than", value: 15_000 }]
      })
    );
    const less = await adapter().preview(
      request({
        filters: [{ bindingId: "sales", operator: "less-than", value: 10_000 }]
      })
    );
    const excluded = await adapter().preview(
      request({
        filters: [
          {
            bindingId: "channel",
            operator: "not-in",
            value: ["Direct", "Online"]
          }
        ]
      })
    );
    const notDirect = await adapter().preview(
      request({
        filters: [{ bindingId: "channel", operator: "not-equals", value: "Direct" }]
      })
    );

    const value = (response: Awaited<ReturnType<FixtureDashboardAdapter["preview"]>>) => {
      const projection = response.projections.find((item) => item.type === "kpi");
      return projection?.type === "kpi" ? projection.value : null;
    };
    expect(value(greater)).toBe(50_250);
    expect(value(less)).toBe(9_400);
    expect(value(excluded)).toBe(19_500);
    expect(value(notDirect)).toBe(69_750);
  });

  it("returns an unavailable projection instead of evaluating a Qlik-only calculation", async () => {
    const qlikManifest: DashboardManifest = {
      ...manifest,
      calculations: [
        ...manifest.calculations,
        {
          calculationId: "qlik-only",
          label: "Qlik only",
          kind: "qlik",
          valueType: "number",
          format: "currency-usd",
          expression: "Sum([Sales])"
        }
      ],
      components: manifest.components.map((component) =>
        component.type === "kpi"
          ? { ...component, calculationId: "qlik-only" }
          : component
      )
    };

    const response = await adapter().preview(request({ manifest: qlikManifest }));
    const projection = response.projections.find((item) => item.type === "kpi");

    expect(projection).toEqual(
      expect.objectContaining({
        type: "kpi",
        status: "unavailable",
        value: null,
        formattedValue: ""
      })
    );
    expect(response.diagnostics).toEqual([
      expect.objectContaining({ code: "qlik-calculation-unavailable" })
    ]);
  });

  it("marks a portable calculation unavailable when it depends on a Qlik calculation", async () => {
    const qlikManifest: DashboardManifest = {
      ...manifest,
      calculations: [
        ...manifest.calculations,
        {
          calculationId: "qlik-only",
          label: "Qlik only",
          kind: "qlik",
          valueType: "number",
          format: "currency-usd",
          expression: "Sum([Sales])"
        },
        {
          calculationId: "portable-wrapper",
          label: "Portable wrapper",
          kind: "portable",
          valueType: "number",
          format: "currency-usd",
          expression: {
            kind: "operation",
            operator: "difference",
            operands: [
              { kind: "calculation", calculationId: "qlik-only" },
              { kind: "literal", value: 1 }
            ]
          }
        }
      ],
      components: manifest.components.map((component) =>
        component.type === "kpi"
          ? { ...component, calculationId: "portable-wrapper" }
          : component
      )
    };

    const response = await adapter().preview(request({ manifest: qlikManifest }));
    const projection = response.projections.find((item) => item.type === "kpi");

    expect(projection).toEqual(
      expect.objectContaining({ type: "kpi", status: "unavailable", value: null })
    );
    expect(response.diagnostics).toEqual([
      expect.objectContaining({ code: "qlik-calculation-unavailable" })
    ]);
  });

  it("rejects a manifest that references a different fixture identity", async () => {
    const mismatched: DashboardManifest = {
      ...manifest,
      runtime: { preferredAdapter: "fixture", fixtureId: "different-fixture" }
    };

    await expect(adapter().preview(request({ manifest: mismatched }))).rejects.toMatchObject({
      code: "adapter-unavailable",
      retryable: false
    });
  });
});
