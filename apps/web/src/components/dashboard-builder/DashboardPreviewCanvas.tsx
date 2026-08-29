import type {
  DashboardManifest,
  DashboardPreviewRequest,
  DashboardPreviewResponse
} from "@unified-ai/contracts/dashboard-builder";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties
} from "react";
import { DashboardRendererRegistry } from "../dashboard-renderers/DashboardRendererRegistry";

type Breakpoint = "large" | "medium" | "small";
type DashboardPreviewFilter = DashboardPreviewRequest["filters"][number];
type DashboardScalarValue = Exclude<DashboardPreviewFilter["value"], unknown[]>;

function viewportBreakpoint(): Breakpoint {
  if (window.innerWidth < 620) return "small";
  if (window.innerWidth < 1024) return "medium";
  return "large";
}

export function DashboardPreviewCanvas({
  manifest,
  preview,
  onFilterChange
}: {
  manifest: DashboardManifest;
  preview: DashboardPreviewResponse;
  onFilterChange: (
    filter: DashboardPreviewRequest["filters"][number] | null
  ) => void;
}) {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(viewportBreakpoint);
  useEffect(() => {
    const update = () => setBreakpoint(viewportBreakpoint());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const projections = useMemo(
    () => new Map(preview.projections.map((projection) => [projection.componentId, projection])),
    [preview.projections]
  );
  const components = useMemo(
    () => new Map(manifest.components.map((component) => [component.componentId, component])),
    [manifest.components]
  );
  const scrollToComponent = useCallback((componentId: string) => {
    document
      .getElementById(`dashboard-preview-component-${componentId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);
  const selectComponentValue = useCallback(
    (sourceComponentId: string, value: DashboardScalarValue) => {
      for (const interaction of manifest.interactions) {
        if (interaction.sourceComponentId !== sourceComponentId) continue;
        if (
          interaction.type === "set-filter" ||
          interaction.type === "select-chart-value"
        ) {
          onFilterChange({
            bindingId: interaction.targetBindingId,
            operator: "equals",
            value
          });
        }
        if (interaction.type === "select-chart-value") {
          scrollToComponent(interaction.targetComponentId);
        }
      }
    },
    [manifest.interactions, onFilterChange, scrollToComponent]
  );
  const style = {
    "--dashboard-surface": manifest.theme.surface,
    "--dashboard-text": manifest.theme.text,
    "--dashboard-accent": manifest.theme.accent,
    "--dashboard-success": manifest.theme.success,
    "--dashboard-warning": manifest.theme.warning,
    "--dashboard-radius": `${String(manifest.theme.radius)}px`,
    "--dashboard-font-scale": String(manifest.theme.fontScale)
  } as CSSProperties;

  return (
    <section className="dashboard-preview-canvas" style={style} data-spacing={manifest.theme.spacing}>
      <header className="dashboard-preview-canvas__heading">
        <div><p className="eyebrow">Live allowlisted React preview</p><h3>{manifest.template.name}</h3></div>
        <span>{breakpoint} · 12 columns</span>
      </header>
      {preview.diagnostics.length === 0 ? null : (
        <ul className="dashboard-preview-diagnostics" aria-label="Preview diagnostics">
          {preview.diagnostics.map((diagnostic) => (
            <li key={`${diagnostic.code}-${diagnostic.path}`} data-severity={diagnostic.severity}>
              <strong>{diagnostic.code.replaceAll("-", " ")}</strong>
              <span>{diagnostic.message}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="dashboard-preview-ruler" aria-hidden="true">
        {Array.from({ length: 12 }, (_, index) => <span key={index}>{index + 1}</span>)}
      </div>
      <div className="dashboard-preview-grid" data-breakpoint={breakpoint}>
        {manifest.layout[breakpoint].map((placement) => {
          const projection = projections.get(placement.componentId);
          const component = components.get(placement.componentId);
          const interactions = manifest.interactions.filter(
            (interaction) => interaction.sourceComponentId === placement.componentId
          );
          const acceptsValueSelection = interactions.some(
            (interaction) =>
              interaction.type === "set-filter" ||
              interaction.type === "select-chart-value"
          );
          const rowSelection = interactions.find(
            (interaction) => interaction.type === "select-row"
          );
          const navigation = interactions.find(
            (interaction) => interaction.type === "navigate-section"
          );
          const clearsFilter = interactions.some(
            (interaction) => interaction.type === "clear-filter"
          );
          const placementStyle = {
            gridColumn: `${String(placement.x + 1)} / span ${String(placement.width)}`,
            gridRow: `${String(placement.y + 1)} / span ${String(placement.height)}`
          };
          return (
            <div
              className="dashboard-preview-grid__item"
              id={`dashboard-preview-component-${placement.componentId}`}
              key={placement.componentId}
              style={placementStyle}
            >
              {projection === undefined || component === undefined ? (
                <div className="dashboard-renderer dashboard-renderer__empty">
                  Preview projection unavailable for {placement.componentId}.
                </div>
              ) : projection.status !== "ready" ? (
                <article className="dashboard-renderer dashboard-renderer__empty" data-status={projection.status}>
                  <header><p>{projection.title}</p><span>{projection.status}</span></header>
                  <p>{component.emptyState}</p>
                  {projection.diagnostics.map((diagnostic) => (
                    <small key={`${diagnostic.code}-${diagnostic.path}`}>
                      {diagnostic.message}
                    </small>
                  ))}
                </article>
              ) : (
                <>
                  <DashboardRendererRegistry
                    component={component}
                    projection={projection}
                    onFilterChange={onFilterChange}
                    {...(rowSelection === undefined
                      ? {}
                      : {
                          onRowSelect: () =>
                            scrollToComponent(rowSelection.targetComponentId)
                        })}
                    {...(acceptsValueSelection
                      ? {
                          onValueSelect: (value: DashboardScalarValue) =>
                            selectComponentValue(placement.componentId, value)
                        }
                      : {})}
                  />
                  {clearsFilter || navigation !== undefined ? (
                    <div className="dashboard-component-actions">
                      {clearsFilter ? (
                        <button type="button" onClick={() => onFilterChange(null)}>
                          Clear configured filters
                        </button>
                      ) : null}
                      {navigation === undefined ? null : (
                        <button type="button" onClick={() => scrollToComponent(navigation.targetComponentId)}>
                          Go to {components.get(navigation.targetComponentId)?.title ?? navigation.targetComponentId}
                        </button>
                      )}
                    </div>
                  ) : null}
                  {projection.diagnostics.length === 0 ? null : (
                    <ul className="dashboard-projection-diagnostics">
                      {projection.diagnostics.map((diagnostic) => (
                        <li key={`${diagnostic.code}-${diagnostic.path}`}>
                          {diagnostic.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
