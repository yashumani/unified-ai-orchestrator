import type {
  DashboardManifest,
  DashboardPreviewRequest,
  DashboardPreviewResponse
} from "@unified-ai/contracts/dashboard-builder";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  QlikDashboardAdapter,
  QlikProviderError,
  type QlikPreviewProvider,
  type QlikProviderPreviewRequest,
  type QlikProviderPreviewResult
} from "./qlik-adapter.js";
import { loadDashboardSample } from "./sample-loader.js";

let manifest: DashboardManifest;

beforeAll(async () => {
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".."
  );
  const sample = await loadDashboardSample(repositoryRoot);
  manifest = {
    ...sample.manifest,
    provenance: {
      source: "qlik-object-metadata",
      sourceReference: {
        tenantId: "tenant-one",
        appId: "app-one",
        objectId: "object-one"
      }
    },
    runtime: { preferredAdapter: "qlik", fixtureId: sample.manifest.runtime.fixtureId }
  };
});

function request(overrides: Partial<DashboardPreviewRequest> = {}): DashboardPreviewRequest {
  return {
    manifest,
    adapterId: "qlik",
    parameterValues: {},
    filters: [],
    sort: [],
    page: { offset: 0, limit: 50 },
    ...overrides
  };
}

function providerResult(): QlikProviderPreviewResult {
  const projections: DashboardPreviewResponse["projections"] = [
    {
      componentId: "sales-kpi",
      title: "Total sales",
      type: "kpi",
      status: "ready",
      diagnostics: [],
      value: 42,
      formattedValue: "$42"
    },
    {
      componentId: "sales-table",
      title: "Sales details",
      type: "data-table",
      status: "ready",
      diagnostics: [],
      columns: [{ columnId: "table-region", header: "Region" }],
      rows: [
        {
          rowId: "qlik-row-one",
          cells: [
            { columnId: "table-region", value: "North", formattedValue: "North" }
          ]
        },
        {
          rowId: "qlik-row-two",
          cells: [
            { columnId: "table-region", value: "South", formattedValue: "South" }
          ]
        },
        {
          rowId: "qlik-row-three",
          cells: [
            { columnId: "table-region", value: "West", formattedValue: "West" }
          ]
        }
      ],
      totalRows: 3,
      offset: 0,
      limit: 3
    },
    {
      componentId: "sales-region-bar",
      title: "Sales by region",
      type: "bar-chart",
      status: "ready",
      diagnostics: [],
      series: [
        {
          calculationId: "total-sales",
          label: "Total sales",
          points: [
            { dimension: "North", value: 20, formattedValue: "$20" },
            { dimension: "South", value: 12, formattedValue: "$12" },
            { dimension: "West", value: 10, formattedValue: "$10" }
          ]
        }
      ]
    },
    {
      componentId: "sales-trend-line",
      title: "Sales over time",
      type: "line-chart",
      status: "ready",
      diagnostics: [],
      series: [
        {
          calculationId: "total-sales",
          label: "Total sales",
          points: [
            { dimension: "2026-01", value: 20, formattedValue: "$20" },
            { dimension: "2026-02", value: 12, formattedValue: "$12" },
            { dimension: "2026-03", value: 10, formattedValue: "$10" }
          ]
        }
      ]
    },
    {
      componentId: "channel-filter",
      title: "Channel",
      type: "filter",
      status: "ready",
      diagnostics: [],
      bindingId: "channel",
      options: [
        { value: "Direct", label: "Direct", count: 2, selected: false },
        { value: "Online", label: "Online", count: 1, selected: false },
        { value: "Partner", label: "Partner", count: 1, selected: false }
      ]
    },
    {
      componentId: "sample-notes",
      title: "About this sample",
      type: "text",
      status: "ready",
      diagnostics: [],
      text: "Provider-owned plain text"
    }
  ];
  return { projections, diagnostics: [] };
}

function enabled(provider: QlikPreviewProvider, maxRows = 2): QlikDashboardAdapter {
  return new QlikDashboardAdapter({
    enabled: true,
    allowedAppIds: ["app-one"],
    maxRows,
    provider,
    now: () => new Date("2026-08-29T13:00:00.000Z")
  });
}

describe("Qlik dashboard adapter", () => {
  it("is unavailable by default and performs no external request", async () => {
    const adapter = new QlikDashboardAdapter();

    await expect(adapter.status()).resolves.toEqual(
      expect.objectContaining({
        adapterId: "qlik",
        status: "unavailable",
        capabilities: {
          portableCalculations: false,
          qlikCalculations: false,
          selections: false,
          paging: false
        },
        diagnostics: [expect.objectContaining({ code: "qlik-adapter-disabled" })]
      })
    );

    const response = await adapter.preview(request());
    expect(response.projections).toHaveLength(6);
    expect(response.projections.every((projection) => projection.status === "unavailable")).toBe(
      true
    );
    expect(response.diagnostics).toEqual([
      expect.objectContaining({ code: "qlik-adapter-disabled" })
    ]);
  });

  it("passes only sanitized source identifiers and a bounded page to an injected provider", async () => {
    let received: QlikProviderPreviewRequest | undefined;
    const provider: QlikPreviewProvider = {
      preview: async (input) => {
        received = input;
        return providerResult();
      }
    };

    const response = await enabled(provider).preview(request());

    expect(received).toEqual(
      expect.objectContaining({
        source: {
          tenantId: "tenant-one",
          appId: "app-one",
          objectId: "object-one"
        },
        page: { offset: 0, limit: 2 }
      })
    );
    expect(Object.keys(received ?? {})).not.toContain("credentials");
    expect(response.generatedAt).toBe("2026-08-29T13:00:00.000Z");
    expect(response.buildId).toMatch(/^qlik-preview-[a-f0-9]{16}$/u);
    const table = response.projections.find((projection) => projection.type === "data-table");
    expect(table?.type === "data-table" ? table.rows : []).toHaveLength(2);
    const chart = response.projections.find((projection) => projection.type === "bar-chart");
    expect(chart?.type === "bar-chart" ? chart.series[0]?.points : []).toHaveLength(2);
    const filter = response.projections.find((projection) => projection.type === "filter");
    expect(filter?.type === "filter" ? filter.options : []).toHaveLength(2);
  });

  it("reports ready capabilities only when an enabled provider is injected", async () => {
    const provider: QlikPreviewProvider = { preview: async () => providerResult() };

    await expect(enabled(provider).status()).resolves.toEqual({
      adapterId: "qlik",
      label: "Qlik governed adapter",
      status: "ready",
      capabilities: {
        portableCalculations: false,
        qlikCalculations: true,
        selections: false,
        paging: true
      },
      diagnostics: []
    });
  });

  it("blocks apps outside the explicit allowlist before invoking the provider", async () => {
    const preview = vi.fn(async () => providerResult());
    const adapter = enabled({ preview });
    const blockedManifest: DashboardManifest = {
      ...manifest,
      provenance: {
        source: "qlik-object-metadata",
        sourceReference: {
          tenantId: "tenant-one",
          appId: "blocked-app",
          objectId: "object-one"
        }
      }
    };

    const response = await adapter.preview(request({ manifest: blockedManifest }));

    expect(preview).not.toHaveBeenCalled();
    expect(response.diagnostics).toEqual([
      expect.objectContaining({ code: "qlik-app-unauthorized", severity: "error" })
    ]);
    expect(response.projections.every((projection) => projection.status === "unavailable")).toBe(
      true
    );
  });

  it.each([
    ["unauthorized", "qlik-unauthorized"],
    ["binding", "qlik-binding-invalid"],
    ["expression", "qlik-expression-invalid"],
    ["unsupported", "qlik-operation-unsupported"],
    ["rate-limit", "qlik-rate-limited"],
    ["unavailable", "qlik-provider-unavailable"]
  ] as const)("maps provider %s failures to the typed %s diagnostic", async (code, expected) => {
    const provider: QlikPreviewProvider = {
      preview: async () => {
        throw new QlikProviderError(code, "sensitive upstream detail");
      }
    };

    const response = await enabled(provider).preview(request());

    expect(response.diagnostics).toEqual([expect.objectContaining({ code: expected })]);
    expect(response.diagnostics[0]?.message).not.toContain("sensitive upstream detail");
    expect(response.projections.every((projection) => projection.status === "unavailable")).toBe(
      true
    );
  });

  it("sanitizes unexpected provider failures", async () => {
    const provider: QlikPreviewProvider = {
      preview: async () => {
        throw new Error("secret-token-should-never-leak");
      }
    };

    const response = await enabled(provider).preview(request());

    expect(JSON.stringify(response)).not.toContain("secret-token-should-never-leak");
    expect(response.diagnostics).toEqual([
      expect.objectContaining({ code: "qlik-provider-unavailable" })
    ]);
  });

  it("strips free-form provider diagnostics from otherwise valid projections", async () => {
    const result = providerResult();
    const first = result.projections[0];
    if (first === undefined) {
      throw new Error("expected a provider projection");
    }
    first.diagnostics.push({
      severity: "warning",
      code: "upstream-detail",
      path: "",
      message: "secret-upstream-diagnostic"
    });
    const provider: QlikPreviewProvider = {
      preview: async () => result
    };

    const response = await enabled(provider).preview(request());

    expect(JSON.stringify(response)).not.toContain("secret-upstream-diagnostic");
    expect(response.projections[0]?.diagnostics).toEqual([]);
  });

  it("rejects provider projections that do not match manifest component identities", async () => {
    const result = providerResult();
    const first = result.projections[0];
    if (first === undefined) {
      throw new Error("expected a provider projection");
    }
    first.componentId = "unexpected-component";
    const provider: QlikPreviewProvider = { preview: async () => result };

    const response = await enabled(provider).preview(request());

    expect(response.diagnostics).toEqual([
      expect.objectContaining({ code: "qlik-provider-unavailable" })
    ]);
    expect(response.projections.every((projection) => projection.status === "unavailable")).toBe(
      true
    );
  });
});
