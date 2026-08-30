import type {
  DashboardManifest,
  DashboardPreviewRequest,
  DashboardPreviewResponse
} from "@unified-ai/contracts/dashboard-builder";
import { BarChartRenderer } from "./BarChartRenderer";
import { DataTableRenderer } from "./DataTableRenderer";
import { FilterRenderer } from "./FilterRenderer";
import { KpiRenderer } from "./KpiRenderer";
import { LineChartRenderer } from "./LineChartRenderer";
import { TextRenderer } from "./TextRenderer";

type DashboardProjection = DashboardPreviewResponse["projections"][number];
type DashboardPreviewFilter = DashboardPreviewRequest["filters"][number];
type DashboardScalarValue = Exclude<DashboardPreviewFilter["value"], unknown[]>;
type DashboardComponent = DashboardManifest["components"][number];

export const ALLOWLISTED_DASHBOARD_RENDERERS = [
  "kpi",
  "data-table",
  "bar-chart",
  "line-chart",
  "filter",
  "text"
] as const;

export function DashboardRendererRegistry({
  component,
  projection,
  onFilterChange,
  onRowSelect,
  onValueSelect
}: {
  component?: DashboardComponent;
  projection: DashboardProjection;
  onFilterChange?: (filter: DashboardPreviewFilter | null) => void;
  onRowSelect?: (rowId: string) => void;
  onValueSelect?: (value: DashboardScalarValue) => void;
}) {
  switch (projection.type) {
    case "kpi":
      return <KpiRenderer projection={projection} />;
    case "data-table":
      return (
        <DataTableRenderer
          projection={projection}
          {...(component?.type === "data-table" ? { component } : {})}
          {...(onRowSelect === undefined ? {} : { onSelectRow: onRowSelect })}
        />
      );
    case "bar-chart":
      return (
        <BarChartRenderer
          projection={projection}
          {...(onValueSelect === undefined ? {} : { onSelectValue: onValueSelect })}
        />
      );
    case "line-chart":
      return (
        <LineChartRenderer
          projection={projection}
          {...(onValueSelect === undefined ? {} : { onSelectValue: onValueSelect })}
        />
      );
    case "filter":
      return (
        <FilterRenderer
          projection={projection}
          {...(component?.type === "filter" ? { component } : {})}
          {...(onFilterChange === undefined ? {} : { onChange: onFilterChange })}
        />
      );
    case "text":
      return <TextRenderer projection={projection} />;
  }
}
