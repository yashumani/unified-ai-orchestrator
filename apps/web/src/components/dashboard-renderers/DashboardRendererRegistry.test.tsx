import type {
  DashboardManifest,
  DashboardPreviewResponse
} from "@unified-ai/contracts/dashboard-builder";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "../../test/render";
import {
  ALLOWLISTED_DASHBOARD_RENDERERS,
  DashboardRendererRegistry
} from "./DashboardRendererRegistry";

type Projection = DashboardPreviewResponse["projections"][number];
const base = {
  title: "Projection",
  status: "ready" as const,
  diagnostics: []
};

const projections: Projection[] = [
  { ...base, componentId: "kpi", type: "kpi", value: 42, formattedValue: "$42" },
  {
    ...base,
    componentId: "table",
    type: "data-table",
    columns: [{ columnId: "value", header: "Value" }],
    rows: [
      {
        rowId: "row-one",
        cells: [{ columnId: "value", value: 42, formattedValue: "42" }]
      }
    ],
    totalRows: 1,
    offset: 0,
    limit: 25
  },
  {
    ...base,
    componentId: "bar",
    type: "bar-chart",
    series: [
      {
        calculationId: "total",
        label: "Total",
        points: [{ dimension: "North", value: 42, formattedValue: "$42" }]
      }
    ]
  },
  {
    ...base,
    componentId: "line",
    type: "line-chart",
    series: [
      {
        calculationId: "total",
        label: "Total",
        points: [{ dimension: "2026-01-01", value: 42, formattedValue: "$42" }]
      }
    ]
  },
  {
    ...base,
    componentId: "filter",
    type: "filter",
    bindingId: "region",
    options: [{ value: "North", label: "North", count: 1, selected: false }]
  },
  {
    ...base,
    componentId: "text",
    type: "text",
    text: "<script>plain text only</script>"
  }
];

afterEach(() => {
  document.body.replaceChildren();
});

describe("allowlisted dashboard renderer registry", () => {
  it("has exactly six compile-time renderer types", () => {
    expect(ALLOWLISTED_DASHBOARD_RENDERERS).toEqual([
      "kpi",
      "data-table",
      "bar-chart",
      "line-chart",
      "filter",
      "text"
    ]);
  });

  it("renders all projections without interpreting text as HTML", async () => {
    const onFilterChange = vi.fn();
    const view = await render(
      <div>
        {projections.map((projection) => (
          <DashboardRendererRegistry
            key={projection.componentId}
            projection={projection}
            onFilterChange={onFilterChange}
          />
        ))}
      </div>
    );

    expect(view.container.querySelectorAll("article")).toHaveLength(6);
    expect(view.container.querySelectorAll('svg[role="img"]')).toHaveLength(2);
    expect(view.container.querySelector("table")?.textContent).toContain("42");
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.textContent).toContain("<script>plain text only</script>");

    const select = view.container.querySelector("select");
    if (!(select instanceof HTMLSelectElement)) throw new Error("filter select missing");
    select.value = '"North"';
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onFilterChange).toHaveBeenCalledWith({
      bindingId: "region",
      operator: "equals",
      value: "North"
    });
    await view.unmount();
  });

  it("preserves signed chart domains, marks missing values, and exposes interaction controls", async () => {
    const onValueSelect = vi.fn();
    const signedProjections: Projection[] = [
      {
        ...base,
        componentId: "signed-bar",
        type: "bar-chart",
        series: [
          {
            calculationId: "signed-total",
            label: "Signed total",
            points: [
              { dimension: "Loss", value: -10, formattedValue: "-$10" },
              { dimension: "Missing", value: null, formattedValue: "" },
              { dimension: "Gain", value: 20, formattedValue: "$20" }
            ]
          }
        ]
      },
      {
        ...base,
        componentId: "signed-line",
        type: "line-chart",
        series: [
          {
            calculationId: "signed-trend",
            label: "Signed trend",
            points: [
              { dimension: "One", value: -10, formattedValue: "-$10" },
              { dimension: "Two", value: null, formattedValue: "" },
              { dimension: "Three", value: 20, formattedValue: "$20" }
            ]
          }
        ]
      }
    ];
    const view = await render(
      <div>
        {signedProjections.map((projection) => (
          <DashboardRendererRegistry
            key={projection.componentId}
            projection={projection}
            onValueSelect={onValueSelect}
          />
        ))}
      </div>
    );

    expect(view.container.querySelector("desc")?.textContent).toContain(
      "Missing: missing"
    );
    expect(view.container.querySelectorAll(".dashboard-chart__missing")).toHaveLength(1);
    expect(view.container.querySelectorAll(".dashboard-chart__series polyline")).toHaveLength(2);
    const barAxis = view.container.querySelector(
      ".dashboard-renderer--chart svg .dashboard-chart__axis"
    );
    expect(Number(barAxis?.getAttribute("y1"))).toBeGreaterThan(20);
    expect(Number(barAxis?.getAttribute("y1"))).toBeLessThan(224);

    const action = view.container.querySelector<HTMLButtonElement>(
      ".dashboard-chart-actions button"
    );
    action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onValueSelect).toHaveBeenCalledWith("Loss");
    await view.unmount();
  });

  it("honors multiselect filters and configured table presentation", async () => {
    const filterProjection = projections.find(
      (projection): projection is Extract<Projection, { type: "filter" }> =>
        projection.type === "filter"
    );
    const tableProjection = projections.find(
      (projection): projection is Extract<Projection, { type: "data-table" }> =>
        projection.type === "data-table"
    );
    if (filterProjection === undefined || tableProjection === undefined) {
      throw new Error("expected filter and table fixtures");
    }
    const filterComponent: Extract<
      DashboardManifest["components"][number],
      { type: "filter" }
    > = {
      componentId: "filter",
      type: "filter",
      title: "Projection",
      adapter: "preferred",
      emptyState: "No filter values.",
      bindingId: "region",
      multiSelect: true
    };
    const tableComponent: Extract<
      DashboardManifest["components"][number],
      { type: "data-table" }
    > = {
      componentId: "table",
      type: "data-table",
      title: "Projection",
      adapter: "preferred",
      emptyState: "No rows.",
      columns: [
        {
          columnId: "value",
          source: { kind: "binding", id: "value" },
          header: "Value",
          alignment: "end",
          width: 180,
          sort: "descending",
          totalBehavior: "sum"
        }
      ],
      pageSize: 25,
      selection: "single"
    };
    const onFilterChange = vi.fn();
    const view = await render(
      <div>
        <DashboardRendererRegistry
          component={filterComponent}
          projection={filterProjection}
          onFilterChange={onFilterChange}
        />
        <DashboardRendererRegistry
          component={tableComponent}
          projection={tableProjection}
        />
      </div>
    );

    const select = view.container.querySelector("select");
    if (!(select instanceof HTMLSelectElement)) throw new Error("filter select missing");
    select.options[0]!.selected = true;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onFilterChange).toHaveBeenCalledWith({
      bindingId: "region",
      operator: "in",
      value: ["North"]
    });
    expect(view.container.querySelector("th")?.textContent).toBe("Select");
    expect(view.container.textContent).toContain("Page sum: 42");
    expect(view.container.textContent).toContain("Value ↓");
    await view.unmount();
  });
});
