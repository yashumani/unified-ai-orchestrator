import { useId } from "react";
import type { DashboardPreviewResponse } from "@unified-ai/contracts/dashboard-builder";

type BarProjection = Extract<
  DashboardPreviewResponse["projections"][number],
  { type: "bar-chart" }
>;
type ChartDimension = BarProjection["series"][number]["points"][number]["dimension"];

function label(value: string | number | boolean | null): string {
  return value === null ? "Null" : String(value);
}

export function BarChartRenderer({
  projection,
  onSelectValue
}: {
  projection: BarProjection;
  onSelectValue?: (value: ChartDimension) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const points = projection.series.flatMap((series) =>
    series.points.map((point) => ({ ...point, series: series.label }))
  );
  const values = points.flatMap((point) =>
    point.value === null ? [] : [point.value]
  );
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const span = Math.max(1, maximum - minimum);
  const top = 20;
  const bottom = 224;
  const y = (value: number) => top + ((maximum - value) / span) * (bottom - top);
  const zeroY = y(0);
  const barWidth = points.length === 0 ? 0 : 560 / points.length;
  const description = points
    .slice(0, 50)
    .map(
      (point) =>
        `${point.series}, ${label(point.dimension)}: ${
          point.value === null ? "missing" : point.formattedValue
        }`
    )
    .join("; ");
  const selectableDimensions = [
    ...new Map(
      points.map((point) => [JSON.stringify(point.dimension), point.dimension])
    ).values()
  ];
  return (
    <article className="dashboard-renderer dashboard-renderer--chart" data-status={projection.status}>
      <header><p>{projection.title}</p><span>Bar</span></header>
      {points.length === 0 ? (
        <p className="dashboard-renderer__empty">No chart points are available.</p>
      ) : (
        <svg viewBox="0 0 600 260" role="img" aria-labelledby={`${titleId} ${descriptionId}`} preserveAspectRatio="none">
          <title id={titleId}>{projection.title}</title>
          <desc id={descriptionId}>{description}</desc>
          <line x1="26" x2="588" y1={zeroY} y2={zeroY} className="dashboard-chart__axis" />
          {points.map((point, index) => {
            const x = 30 + index * barWidth;
            if (point.value === null) {
              return (
                <g key={`${point.series}-${label(point.dimension)}-${String(index)}`}>
                  <text className="dashboard-chart__missing" x={x + Math.max(8, barWidth - 8) / 2} y={zeroY - 6} textAnchor="middle">—</text>
                  <text x={x + Math.max(8, barWidth - 8) / 2} y="246" textAnchor="middle">
                    {label(point.dimension).slice(0, 10)}
                  </text>
                </g>
              );
            }
            const valueY = y(point.value);
            const height = Math.max(1, Math.abs(zeroY - valueY));
            return (
              <g key={`${point.series}-${label(point.dimension)}-${String(index)}`}>
                <rect x={x} y={Math.min(valueY, zeroY)} width={Math.max(8, barWidth - 8)} height={height} rx="3">
                  <title>{`${point.series}, ${label(point.dimension)}: ${point.formattedValue}`}</title>
                </rect>
                <text x={x + Math.max(8, barWidth - 8) / 2} y="246" textAnchor="middle">
                  {label(point.dimension).slice(0, 10)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {onSelectValue === undefined ? null : (
        <div className="dashboard-chart-actions" aria-label={`${projection.title} selections`}>
          {selectableDimensions.map((dimension) => (
            <button type="button" key={JSON.stringify(dimension)} onClick={() => onSelectValue(dimension)}>
              Filter by {label(dimension)}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
