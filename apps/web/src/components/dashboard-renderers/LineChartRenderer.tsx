import { useId } from "react";
import type { DashboardPreviewResponse } from "@unified-ai/contracts/dashboard-builder";

type LineProjection = Extract<
  DashboardPreviewResponse["projections"][number],
  { type: "line-chart" }
>;
type ChartDimension = LineProjection["series"][number]["points"][number]["dimension"];

export function LineChartRenderer({
  projection,
  onSelectValue
}: {
  projection: LineProjection;
  onSelectValue?: (value: ChartDimension) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const values = projection.series.flatMap((series) =>
    series.points.flatMap((point) => point.value === null ? [] : [point.value])
  );
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(0, ...values);
  const span = Math.max(1, maximum - minimum);
  const top = 20;
  const bottom = 224;
  const y = (value: number) => top + ((maximum - value) / span) * (bottom - top);
  const zeroY = y(0);
  const description = projection.series
    .flatMap((series) =>
      series.points.map(
        (point) =>
          `${series.label}, ${String(point.dimension)}: ${
            point.value === null ? "missing" : point.formattedValue
          }`
      )
    )
    .slice(0, 50)
    .join("; ");
  const selectableDimensions = [
    ...new Map(
      projection.series.flatMap((series) =>
        series.points.map((point) => [JSON.stringify(point.dimension), point.dimension] as const)
      )
    ).values()
  ];
  return (
    <article className="dashboard-renderer dashboard-renderer--chart" data-status={projection.status}>
      <header><p>{projection.title}</p><span>Line</span></header>
      {projection.series.every((series) => series.points.length === 0) ? (
        <p className="dashboard-renderer__empty">No trend points are available.</p>
      ) : (
        <svg viewBox="0 0 600 260" role="img" aria-labelledby={`${titleId} ${descriptionId}`} preserveAspectRatio="none">
          <title id={titleId}>{projection.title}</title>
          <desc id={descriptionId}>{description}</desc>
          <line x1="26" x2="588" y1={zeroY} y2={zeroY} className="dashboard-chart__axis" />
          {projection.series.map((series, seriesIndex) => {
            const denominator = Math.max(1, series.points.length - 1);
            const coordinates = series.points.map((point, index) => ({
              x: 32 + (index / denominator) * 550,
              y: point.value === null ? null : y(point.value),
              point
            }));
            const segments = coordinates.reduce<Array<typeof coordinates>>(
              (groups, coordinate) => {
                if (coordinate.y === null) {
                  if (groups.at(-1)?.length !== 0) groups.push([]);
                } else {
                  (groups.at(-1) ?? groups[0])?.push(coordinate);
                }
                return groups;
              },
              [[]]
            ).filter((segment) => segment.length > 0);
            return (
              <g className={`dashboard-chart__series dashboard-chart__series--${String(seriesIndex % 3)}`} key={series.calculationId}>
                {segments.map((segment, segmentIndex) => (
                  <polyline key={segmentIndex} points={segment.map((point) => `${String(point.x)},${String(point.y)}`).join(" ")} />
                ))}
                {coordinates.filter((coordinate) => coordinate.y !== null).map(({ x, y: pointY, point }, index) => (
                  <circle cx={x} cy={pointY ?? zeroY} r="5" key={`${String(point.dimension)}-${String(index)}`}>
                    <title>{`${series.label}, ${String(point.dimension)}: ${point.formattedValue}`}</title>
                  </circle>
                ))}
              </g>
            );
          })}
        </svg>
      )}
      {onSelectValue === undefined ? null : (
        <div className="dashboard-chart-actions" aria-label={`${projection.title} selections`}>
          {selectableDimensions.map((dimension) => (
            <button type="button" key={JSON.stringify(dimension)} onClick={() => onSelectValue(dimension)}>
              Filter by {dimension === null ? "Null" : String(dimension)}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
