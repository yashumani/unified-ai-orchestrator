import type {
  DashboardPreviewResponse,
  DashboardTemplateResponse,
  DashboardValidationResult
} from "@unified-ai/contracts/dashboard-builder";

export function ManifestLineage({
  template,
  validation,
  preview,
  dirty
}: {
  template: DashboardTemplateResponse | null;
  validation: DashboardValidationResult | null;
  preview: DashboardPreviewResponse | null;
  dirty: boolean;
}) {
  const steps = [
    { label: "Sample", detail: "Owned v1 contract", complete: true },
    {
      label: "Draft",
      detail: template === null ? "Not created" : dirty ? "Unsaved changes" : `Event ${String(template.template.currentRevision)}`,
      complete: template !== null
    },
    {
      label: "Validated",
      detail: validation?.valid === true ? "Normalized" : "Needs attention",
      complete: validation?.valid === true
    },
    {
      label: preview?.adapterId === "qlik" ? "Qlik preview" : "Fixture preview",
      detail: preview === null ? "Waiting" : preview.buildId,
      complete: preview !== null
    },
    {
      label: "Published",
      detail:
        template?.template.activeRevisionNumber === null || template === null
          ? "No revision"
          : `Revision ${String(template.template.activeRevisionNumber)}`,
      complete: template?.template.activeRevisionNumber !== null && template !== null
    }
  ];
  return (
    <section className="manifest-lineage" aria-labelledby="manifest-lineage-title">
      <div className="manifest-lineage__heading">
        <div>
          <p className="eyebrow">Manifest lineage</p>
          <h2 id="manifest-lineage-title">Declarative input to immutable revision</h2>
        </div>
        <code>{template?.template.manifestSha256.slice(0, 12) ?? "no-hash-yet"}</code>
      </div>
      <ol>
        {steps.map((step, index) => (
          <li key={step.label} data-complete={String(step.complete)}>
            <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <div><strong>{step.label}</strong><small>{step.detail}</small></div>
          </li>
        ))}
      </ol>
    </section>
  );
}
