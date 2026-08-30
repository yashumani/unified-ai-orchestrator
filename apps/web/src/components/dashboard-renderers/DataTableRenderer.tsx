import type {
  DashboardManifest,
  DashboardPreviewResponse
} from "@unified-ai/contracts/dashboard-builder";
import { useState, type CSSProperties } from "react";

type TableProjection = Extract<
  DashboardPreviewResponse["projections"][number],
  { type: "data-table" }
>;
type TableComponent = Extract<
  DashboardManifest["components"][number],
  { type: "data-table" }
>;

function alignment(value: "start" | "center" | "end"): CSSProperties["textAlign"] {
  return value === "start" ? "left" : value === "end" ? "right" : "center";
}

function visibleTotal(
  projection: TableProjection,
  columnId: string,
  behavior: "none" | "sum" | "average" | "count"
): string {
  if (behavior === "none") return "";
  const values = projection.rows
    .map((row) => row.cells.find((cell) => cell.columnId === columnId)?.value)
    .filter((value) => value !== undefined && value !== null);
  if (behavior === "count") return `Page count: ${String(values.length)}`;
  const numbers = values.filter((value): value is number => typeof value === "number");
  if (numbers.length === 0) return "No numeric page values";
  const sum = numbers.reduce((total, value) => total + value, 0);
  return behavior === "sum"
    ? `Page sum: ${String(sum)}`
    : `Page average: ${String(sum / numbers.length)}`;
}

export function DataTableRenderer({
  component,
  projection,
  onSelectRow
}: {
  component?: TableComponent;
  projection: TableProjection;
  onSelectRow?: (rowId: string) => void;
}) {
  const [selectedRows, setSelectedRows] = useState<Set<string>>(() => new Set());
  const selection = component?.selection ?? "none";
  const toggleRow = (rowId: string) => {
    setSelectedRows((current) => {
      if (selection === "single") return new Set([rowId]);
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
    onSelectRow?.(rowId);
  };
  return (
    <article className="dashboard-renderer dashboard-renderer--table" data-status={projection.status}>
      <header>
        <p>{projection.title}</p>
        <span>{projection.totalRows} rows</span>
      </header>
      {projection.rows.length === 0 ? (
        <p className="dashboard-renderer__empty">No rows match the current preview.</p>
      ) : (
        <div className="dashboard-renderer__table-wrap" tabIndex={0} aria-label={`${projection.title} scrollable table`}>
          <p className="dashboard-table-meta">
            Rows {String(projection.offset + 1)}–{String(projection.offset + projection.rows.length)} of {String(projection.totalRows)}
            {component === undefined ? "" : ` · ${component.selection} selection · page size ${String(component.pageSize)}`}
          </p>
          <table>
            <thead>
              <tr>
                {selection === "none" ? null : <th scope="col">Select</th>}
                {projection.columns.map((column) => (
                  <th
                    scope="col"
                    key={column.columnId}
                    style={
                      component === undefined
                        ? undefined
                        : {
                            width: component.columns.find((value) => value.columnId === column.columnId)?.width,
                            textAlign: alignment(component.columns.find((value) => value.columnId === column.columnId)?.alignment ?? "start")
                          }
                    }
                  >
                    {column.header}
                    {component?.columns.find((value) => value.columnId === column.columnId)?.sort === "ascending" ? " ↑" : component?.columns.find((value) => value.columnId === column.columnId)?.sort === "descending" ? " ↓" : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {projection.rows.map((row) => (
                <tr key={row.rowId}>
                  {selection === "none" ? null : (
                    <td>
                      <input
                        type={selection === "single" ? "radio" : "checkbox"}
                        name={selection === "single" ? `${projection.componentId}-selection` : undefined}
                        aria-label={`Select row ${row.rowId}`}
                        checked={selectedRows.has(row.rowId)}
                        onChange={() => toggleRow(row.rowId)}
                      />
                    </td>
                  )}
                  {projection.columns.map((column) => {
                    const cell = row.cells.find((value) => value.columnId === column.columnId);
                    const configuration = component?.columns.find((value) => value.columnId === column.columnId);
                    return <td key={column.columnId} style={{ textAlign: alignment(configuration?.alignment ?? "start") }}>{cell?.formattedValue ?? "—"}</td>;
                  })}
                </tr>
              ))}
            </tbody>
            {component === undefined || component.columns.every((column) => column.totalBehavior === "none") ? null : (
              <tfoot>
                <tr>
                  {selection === "none" ? null : <th scope="row">Visible totals</th>}
                  {projection.columns.map((column, index) => {
                    const configuration = component.columns.find((value) => value.columnId === column.columnId);
                    return (
                      <td key={column.columnId}>
                        {index === 0 && selection === "none" ? <span className="visually-hidden">Visible totals: </span> : null}
                        {visibleTotal(projection, column.columnId, configuration?.totalBehavior ?? "none")}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </article>
  );
}
