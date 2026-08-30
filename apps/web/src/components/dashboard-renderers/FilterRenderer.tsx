import type {
  DashboardManifest,
  DashboardPreviewRequest,
  DashboardPreviewResponse
} from "@unified-ai/contracts/dashboard-builder";

type FilterProjection = Extract<
  DashboardPreviewResponse["projections"][number],
  { type: "filter" }
>;
type DashboardPreviewFilter = DashboardPreviewRequest["filters"][number];
type FilterComponent = Extract<
  DashboardManifest["components"][number],
  { type: "filter" }
>;

export function FilterRenderer({
  component,
  projection,
  onChange
}: {
  component?: FilterComponent;
  projection: FilterProjection;
  onChange?: (filter: DashboardPreviewFilter | null) => void;
}) {
  const selected = projection.options.find((option) => option.selected);
  const selectedValues = projection.options
    .filter((option) => option.selected)
    .map((option) => JSON.stringify(option.value));
  const multiSelect = component?.multiSelect ?? false;
  return (
    <article className="dashboard-renderer dashboard-renderer--filter" data-status={projection.status}>
      <header><p>{projection.title}</p><span>Filter</span></header>
      <label>
        Preview selection
        <select
          multiple={multiSelect}
          value={
            multiSelect
              ? selectedValues
              : selected === undefined
                ? ""
                : JSON.stringify(selected.value)
          }
          onChange={(event) => {
            const selectedOptions = Array.from(event.currentTarget.selectedOptions);
            if (multiSelect) {
              const values = selectedOptions.map(
                (option) =>
                  JSON.parse(option.value) as DashboardPreviewFilter["value"]
              );
              onChange?.(
                values.length === 0
                  ? null
                  : {
                      bindingId: projection.bindingId,
                      operator: "in",
                      value: values.flatMap((value) =>
                        Array.isArray(value) ? value : [value]
                      )
                    }
              );
              return;
            }
            onChange?.(
              event.target.value === ""
                ? null
                : {
                    bindingId: projection.bindingId,
                    operator: "equals",
                    value: JSON.parse(event.target.value) as
                      DashboardPreviewFilter["value"]
                  }
            );
          }}
        >
          {multiSelect ? null : <option value="">All values</option>}
          {projection.options.map((option) => (
            <option key={`${String(option.value)}-${option.label}`} value={JSON.stringify(option.value)}>
              {option.label} ({option.count})
            </option>
          ))}
        </select>
      </label>
    </article>
  );
}
