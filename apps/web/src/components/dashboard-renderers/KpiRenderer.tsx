import type { DashboardPreviewResponse } from "@unified-ai/contracts/dashboard-builder";

type KpiProjection = Extract<
  DashboardPreviewResponse["projections"][number],
  { type: "kpi" }
>;

export function KpiRenderer({ projection }: { projection: KpiProjection }) {
  return (
    <article className="dashboard-renderer dashboard-renderer--kpi" data-status={projection.status}>
      <header>
        <p>{projection.title}</p>
        <span>KPI</span>
      </header>
      {projection.status === "empty" ? (
        <p className="dashboard-renderer__empty">No value is available.</p>
      ) : (
        <strong>{projection.formattedValue}</strong>
      )}
    </article>
  );
}
