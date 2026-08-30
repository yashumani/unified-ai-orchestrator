import type { DashboardPreviewResponse } from "@unified-ai/contracts/dashboard-builder";

type TextProjection = Extract<
  DashboardPreviewResponse["projections"][number],
  { type: "text" }
>;

export function TextRenderer({ projection }: { projection: TextProjection }) {
  return (
    <article className="dashboard-renderer dashboard-renderer--text" data-status={projection.status}>
      <header><p>{projection.title}</p><span>Note</span></header>
      <p>{projection.text}</p>
    </article>
  );
}
