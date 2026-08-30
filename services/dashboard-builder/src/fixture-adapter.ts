import {
  DashboardFixtureDatasetSchema,
  DashboardPreviewRequestSchema,
  DashboardPreviewResponseSchema,
  type DashboardDiagnostic,
  type DashboardFixtureDataset,
  type DashboardManifest,
  type DashboardPreviewRequest,
  type DashboardPreviewResponse
} from "@unified-ai/contracts/dashboard-builder";
import { canonicalJson, sha256Hex } from "@unified-ai/evidence-index";
import {
  evaluatePortableCalculation,
  type DashboardCalculationRow,
  type DashboardPrimitive
} from "./calculation-engine.js";
import type { DashboardDataAdapter } from "./data-adapter.js";
import { DashboardBuilderError } from "./errors.js";

type DashboardComponent = DashboardManifest["components"][number];
type DashboardBinding = DashboardManifest["bindings"][number];
type DashboardProjection = DashboardPreviewResponse["projections"][number];
type DashboardValueSource = DashboardPreviewRequest["sort"][number]["source"];

interface IndexedRow {
  readonly row: DashboardCalculationRow;
  readonly sourceIndex: number;
}

export interface FixtureDashboardAdapterOptions {
  now?: () => Date;
}

function diagnosticKey(diagnostic: DashboardDiagnostic): string {
  return [
    diagnostic.severity,
    diagnostic.code,
    diagnostic.path,
    diagnostic.componentId ?? "",
    diagnostic.calculationId ?? "",
    diagnostic.bindingId ?? ""
  ].join("|");
}

function mergeDiagnostics(
  target: DashboardDiagnostic[],
  incoming: readonly DashboardDiagnostic[]
): void {
  const keys = new Set(target.map(diagnosticKey));
  for (const diagnostic of incoming) {
    const key = diagnosticKey(diagnostic);
    if (!keys.has(key)) {
      target.push(diagnostic);
      keys.add(key);
    }
  }
}

function preventsFixtureProjection(diagnostics: readonly DashboardDiagnostic[]): boolean {
  return diagnostics.some(
    (diagnostic) =>
      diagnostic.severity === "error" ||
      diagnostic.code === "qlik-calculation-unavailable"
  );
}

function bindingValue(
  binding: DashboardBinding,
  row: DashboardCalculationRow
): DashboardPrimitive {
  const value = row[binding.sourceField] ?? null;
  if (value !== null) {
    return value;
  }
  if (binding.nullHandling === "zero") {
    return 0;
  }
  if (binding.nullHandling === "empty") {
    return "";
  }
  return null;
}

function equals(left: DashboardPrimitive, right: DashboardPrimitive): boolean {
  return Object.is(left, right);
}

function comparison(left: DashboardPrimitive, right: DashboardPrimitive): number | null {
  if (typeof left === "number" && typeof right === "number") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left.localeCompare(right, "en", { numeric: true, sensitivity: "variant" });
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === right ? 0 : left ? 1 : -1;
  }
  return null;
}

function compareForSort(left: DashboardPrimitive, right: DashboardPrimitive): number {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  const comparable = comparison(left, right);
  if (comparable !== null) {
    return comparable;
  }
  return `${typeof left}:${String(left)}`.localeCompare(
    `${typeof right}:${String(right)}`,
    "en",
    { numeric: true, sensitivity: "variant" }
  );
}

function compareWithDirection(
  left: DashboardPrimitive,
  right: DashboardPrimitive,
  direction: "ascending" | "descending"
): number {
  const result = compareForSort(left, right);
  if (left === null || right === null) {
    return result;
  }
  return direction === "ascending" ? result : -result;
}

function matchesFilter(
  rowValue: DashboardPrimitive,
  filter: DashboardPreviewRequest["filters"][number]
): boolean {
  const requested = Array.isArray(filter.value) ? filter.value : [filter.value];
  if (filter.operator === "equals" || filter.operator === "in") {
    return requested.some((value) => equals(rowValue, value));
  }
  if (filter.operator === "not-equals" || filter.operator === "not-in") {
    return requested.every((value) => !equals(rowValue, value));
  }
  if (Array.isArray(filter.value)) {
    return false;
  }
  const result = comparison(rowValue, filter.value);
  if (result === null) {
    return false;
  }
  return filter.operator === "greater-than" ? result > 0 : result < 0;
}

function formatValue(value: DashboardPrimitive, format: string | null): string {
  if (value === null) {
    return "";
  }
  if (typeof value === "number") {
    if (format === "currency-usd") {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
      }).format(value);
    }
    if (format === "integer") {
      return new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 0
      }).format(value);
    }
    if (format === "percent") {
      return new Intl.NumberFormat("en-US", {
        style: "percent",
        maximumFractionDigits: 2
      }).format(value);
    }
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 12 }).format(value);
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return value;
}

function parameterValuesForRequest(
  request: DashboardPreviewRequest
): DashboardPreviewRequest["parameterValues"] {
  const defaults = Object.fromEntries(
    request.manifest.parameters.map((parameter) => [
      parameter.parameterId,
      parameter.defaultValue
    ])
  );
  return { ...defaults, ...request.parameterValues };
}

function unavailableProjection(
  component: DashboardComponent,
  diagnostic: DashboardDiagnostic,
  request: DashboardPreviewRequest
): DashboardProjection {
  const base = {
    componentId: component.componentId,
    title: component.title,
    status: "unavailable" as const,
    diagnostics: [diagnostic]
  };
  if (component.type === "kpi") {
    return { ...base, type: "kpi", value: null, formattedValue: "" };
  }
  if (component.type === "data-table") {
    return {
      ...base,
      type: "data-table",
      columns: component.columns.map((column) => ({
        columnId: column.columnId,
        header: column.header
      })),
      rows: [],
      totalRows: 0,
      offset: request.page.offset,
      limit: Math.min(request.page.limit, component.pageSize)
    };
  }
  if (component.type === "bar-chart" || component.type === "line-chart") {
    return { ...base, type: component.type, series: [] };
  }
  if (component.type === "filter") {
    return { ...base, type: "filter", bindingId: component.bindingId, options: [] };
  }
  return { ...base, type: "text", text: "" };
}

export class FixtureDashboardAdapter implements DashboardDataAdapter {
  readonly adapterId = "fixture" as const;
  readonly #dataset: DashboardFixtureDataset;
  readonly #now: () => Date;

  constructor(
    dataset: DashboardFixtureDataset,
    options: FixtureDashboardAdapterOptions = {}
  ) {
    this.#dataset = DashboardFixtureDatasetSchema.parse(dataset);
    this.#now = options.now ?? (() => new Date());
  }

  async status() {
    return {
      adapterId: this.adapterId,
      label: "Tracked synthetic fixture",
      status: "ready" as const,
      capabilities: {
        portableCalculations: true,
        qlikCalculations: false,
        selections: true,
        paging: true
      },
      diagnostics: []
    };
  }

  async preview(input: DashboardPreviewRequest): Promise<DashboardPreviewResponse> {
    let request: DashboardPreviewRequest;
    try {
      request = DashboardPreviewRequestSchema.parse(input);
    } catch (error) {
      throw new DashboardBuilderError(
        "invalid-dashboard-request",
        "The fixture preview request failed contract validation.",
        { cause: error }
      );
    }
    if (request.adapterId !== this.adapterId) {
      throw new DashboardBuilderError(
        "adapter-unavailable",
        "The fixture adapter cannot handle the requested adapter identity."
      );
    }
    if (
      request.manifest.runtime.fixtureId === null ||
      request.manifest.runtime.fixtureId !== this.#dataset.fixtureId
    ) {
      throw new DashboardBuilderError(
        "adapter-unavailable",
        "The requested dashboard fixture is not registered."
      );
    }

    const bindings = new Map(
      request.manifest.bindings.map((binding) => [binding.bindingId, binding])
    );
    const calculations = new Map(
      request.manifest.calculations.map((calculation) => [
        calculation.calculationId,
        calculation
      ])
    );
    const parameterValues = parameterValuesForRequest(request);
    const responseDiagnostics: DashboardDiagnostic[] = [];
    const indexedRows: IndexedRow[] = this.#dataset.rows.map((row, sourceIndex) => ({
      row,
      sourceIndex
    }));

    const rowMatchesActiveFilters = (
      row: DashboardCalculationRow,
      excludedBindingId?: string
    ): boolean =>
      request.filters.every((filter) => {
        if (filter.bindingId === excludedBindingId) {
          return true;
        }
        const binding = bindings.get(filter.bindingId);
        if (binding === undefined) {
          return false;
        }
        return matchesFilter(bindingValue(binding, row), filter);
      });
    const filteredRows = indexedRows.filter(({ row }) => rowMatchesActiveFilters(row));

    const valueForSource = (
      source: DashboardValueSource,
      row: DashboardCalculationRow
    ): { value: DashboardPrimitive; diagnostics: DashboardDiagnostic[] } => {
      if (source.kind === "binding") {
        const binding = bindings.get(source.id);
        return {
          value: binding === undefined ? null : bindingValue(binding, row),
          diagnostics: []
        };
      }
      return evaluatePortableCalculation(source.id, {
        bindings: request.manifest.bindings,
        calculations: request.manifest.calculations,
        rows: [row],
        parameterValues
      });
    };

    const sortKeys = new Map<number, DashboardPrimitive[]>();
    for (const indexed of filteredRows) {
      const keys = request.sort.map((sort) => {
        const result = valueForSource(sort.source, indexed.row);
        mergeDiagnostics(responseDiagnostics, result.diagnostics);
        return result.value;
      });
      sortKeys.set(indexed.sourceIndex, keys);
    }
    const sortedRows = [...filteredRows].sort((left, right) => {
      for (const [index, sort] of request.sort.entries()) {
        const result = compareWithDirection(
          sortKeys.get(left.sourceIndex)?.[index] ?? null,
          sortKeys.get(right.sourceIndex)?.[index] ?? null,
          sort.direction
        );
        if (result !== 0) {
          return result;
        }
      }
      return left.sourceIndex - right.sourceIndex;
    });

    const projections = request.manifest.components.map((component, componentIndex) => {
      const qlikAdapterDiagnostic: DashboardDiagnostic = {
        severity: "warning",
        code: "fixture-component-requires-qlik",
        path: `/components/${String(componentIndex)}/adapter`,
        message: "This component requires the Qlik adapter and was not evaluated from fixture rows.",
        remediation: "Use an authorized Qlik adapter or select a portable component source.",
        componentId: component.componentId
      };
      if (component.adapter === "qlik") {
        mergeDiagnostics(responseDiagnostics, [qlikAdapterDiagnostic]);
        return unavailableProjection(component, qlikAdapterDiagnostic, request);
      }

      if (component.type === "kpi") {
        const calculation = calculations.get(component.calculationId);
        if (calculation?.kind === "qlik") {
          const result = evaluatePortableCalculation(component.calculationId, {
            bindings: request.manifest.bindings,
            calculations: request.manifest.calculations,
            rows: sortedRows.map((item) => item.row),
            parameterValues
          });
          mergeDiagnostics(responseDiagnostics, result.diagnostics);
          const diagnostic = result.diagnostics[0] ?? qlikAdapterDiagnostic;
          return unavailableProjection(component, diagnostic, request);
        }
        const result = evaluatePortableCalculation(component.calculationId, {
          bindings: request.manifest.bindings,
          calculations: request.manifest.calculations,
          rows: sortedRows.map((item) => item.row),
          parameterValues
        });
        mergeDiagnostics(responseDiagnostics, result.diagnostics);
        if (preventsFixtureProjection(result.diagnostics)) {
          return unavailableProjection(
            component,
            result.diagnostics[0] ?? qlikAdapterDiagnostic,
            request
          );
        }
        const calculationFormat = calculation?.format ?? null;
        return {
          componentId: component.componentId,
          title: component.title,
          type: "kpi" as const,
          status: "ready" as const,
          diagnostics: result.diagnostics.slice(0, 100),
          value: result.value,
          formattedValue: formatValue(result.value, component.format ?? calculationFormat)
        };
      }

      if (component.type === "data-table") {
        const qlikColumn = component.columns.find(
          (column) =>
            column.source.kind === "calculation" &&
            calculations.get(column.source.id)?.kind === "qlik"
        );
        if (qlikColumn !== undefined && qlikColumn.source.kind === "calculation") {
          const result = evaluatePortableCalculation(qlikColumn.source.id, {
            bindings: request.manifest.bindings,
            calculations: request.manifest.calculations,
            rows: sortedRows.map((item) => item.row),
            parameterValues
          });
          mergeDiagnostics(responseDiagnostics, result.diagnostics);
          return unavailableProjection(
            component,
            result.diagnostics[0] ?? qlikAdapterDiagnostic,
            request
          );
        }
        const limit = Math.min(request.page.limit, component.pageSize);
        const pageRows = sortedRows.slice(request.page.offset, request.page.offset + limit);
        const componentDiagnostics: DashboardDiagnostic[] = [];
        const rows = pageRows.map((indexed) => ({
          rowId: `fixture-row-${String(indexed.sourceIndex + 1)}`,
          cells: component.columns.map((column) => {
            const result = valueForSource(column.source, indexed.row);
            mergeDiagnostics(componentDiagnostics, result.diagnostics);
            const sourceFormat =
              column.source.kind === "binding"
                ? bindings.get(column.source.id)?.format ?? null
                : calculations.get(column.source.id)?.format ?? null;
            return {
              columnId: column.columnId,
              value: result.value,
              formattedValue: formatValue(result.value, sourceFormat)
            };
          })
        }));
        mergeDiagnostics(responseDiagnostics, componentDiagnostics);
        if (preventsFixtureProjection(componentDiagnostics)) {
          return unavailableProjection(
            component,
            componentDiagnostics[0] ?? qlikAdapterDiagnostic,
            request
          );
        }
        return {
          componentId: component.componentId,
          title: component.title,
          type: "data-table" as const,
          status: sortedRows.length === 0 ? ("empty" as const) : ("ready" as const),
          diagnostics: componentDiagnostics.slice(0, 100),
          columns: component.columns.map((column) => ({
            columnId: column.columnId,
            header: column.header
          })),
          rows,
          totalRows: sortedRows.length,
          offset: request.page.offset,
          limit
        };
      }

      if (component.type === "bar-chart" || component.type === "line-chart") {
        const qlikCalculationId = component.calculationIds.find(
          (calculationId) => calculations.get(calculationId)?.kind === "qlik"
        );
        if (qlikCalculationId !== undefined) {
          const result = evaluatePortableCalculation(qlikCalculationId, {
            bindings: request.manifest.bindings,
            calculations: request.manifest.calculations,
            rows: sortedRows.map((item) => item.row),
            parameterValues
          });
          mergeDiagnostics(responseDiagnostics, result.diagnostics);
          return unavailableProjection(
            component,
            result.diagnostics[0] ?? qlikAdapterDiagnostic,
            request
          );
        }
        const dimensionBinding = bindings.get(component.dimensionBindingId);
        const groups = new Map<string, { dimension: DashboardPrimitive; rows: DashboardCalculationRow[] }>();
        if (dimensionBinding !== undefined) {
          for (const indexed of sortedRows) {
            const dimension = bindingValue(dimensionBinding, indexed.row);
            if (dimension === null && dimensionBinding.nullHandling === "exclude") {
              continue;
            }
            const key = canonicalJson([typeof dimension, dimension]);
            const existing = groups.get(key);
            if (existing === undefined) {
              groups.set(key, { dimension, rows: [indexed.row] });
            } else {
              existing.rows.push(indexed.row);
            }
          }
        }
        const componentDiagnostics: DashboardDiagnostic[] = [];
        const groupResults = [...groups.values()].map((group, sourceIndex) => ({
          ...group,
          sourceIndex,
          values: Object.fromEntries(
            component.calculationIds.map((calculationId) => {
              const result = evaluatePortableCalculation(calculationId, {
                bindings: request.manifest.bindings,
                calculations: request.manifest.calculations,
                rows: group.rows,
                parameterValues
              });
              mergeDiagnostics(componentDiagnostics, result.diagnostics);
              return [calculationId, result.value];
            })
          ) as Record<string, DashboardPrimitive>
        }));
        groupResults.sort((left, right) => {
          const valueSort = component.sort.startsWith("value-");
          const leftValue = valueSort
            ? left.values[component.calculationIds[0] ?? ""] ?? null
            : left.dimension;
          const rightValue = valueSort
            ? right.values[component.calculationIds[0] ?? ""] ?? null
            : right.dimension;
          const result = compareWithDirection(
            leftValue,
            rightValue,
            component.sort.endsWith("ascending") ? "ascending" : "descending"
          );
          if (result !== 0) {
            return result;
          }
          return left.sourceIndex - right.sourceIndex;
        });
        const pagedGroups = groupResults.slice(
          request.page.offset,
          request.page.offset + request.page.limit
        );
        const series = component.calculationIds.map((calculationId) => {
          const calculation = calculations.get(calculationId);
          return {
            calculationId,
            label: calculation?.label ?? calculationId,
            points: pagedGroups.map((group) => {
              const primitive = group.values[calculationId] ?? null;
              const value = typeof primitive === "number" ? primitive : null;
              return {
                dimension: group.dimension,
                value,
                formattedValue: formatValue(value, calculation?.format ?? null)
              };
            })
          };
        });
        mergeDiagnostics(responseDiagnostics, componentDiagnostics);
        if (preventsFixtureProjection(componentDiagnostics)) {
          return unavailableProjection(
            component,
            componentDiagnostics[0] ?? qlikAdapterDiagnostic,
            request
          );
        }
        return {
          componentId: component.componentId,
          title: component.title,
          type: component.type,
          status: groups.size === 0 ? ("empty" as const) : ("ready" as const),
          diagnostics: componentDiagnostics.slice(0, 100),
          series
        };
      }

      if (component.type === "filter") {
        const binding = bindings.get(component.bindingId);
        const optionRows = indexedRows.filter(({ row }) =>
          rowMatchesActiveFilters(row, component.bindingId)
        );
        const options = new Map<
          string,
          { value: DashboardPrimitive; count: number; sourceIndex: number }
        >();
        if (binding !== undefined) {
          for (const indexed of optionRows) {
            const value = bindingValue(binding, indexed.row);
            if (value === null && binding.nullHandling === "exclude") {
              continue;
            }
            const key = canonicalJson([typeof value, value]);
            const existing = options.get(key);
            if (existing === undefined) {
              options.set(key, { value, count: 1, sourceIndex: indexed.sourceIndex });
            } else {
              existing.count += 1;
            }
          }
        }
        const selectedFilters = request.filters.filter(
          (filter) =>
            filter.bindingId === component.bindingId &&
            (filter.operator === "equals" || filter.operator === "in")
        );
        const projectedOptions = [...options.values()]
          .sort((left, right) => {
            const result = compareForSort(left.value, right.value);
            return result === 0 ? left.sourceIndex - right.sourceIndex : result;
          })
          .slice(request.page.offset, request.page.offset + request.page.limit)
          .map((option) => ({
            value: option.value,
            label: formatValue(option.value, binding?.format ?? null),
            count: option.count,
            selected: selectedFilters.some((filter) => matchesFilter(option.value, filter))
          }));
        return {
          componentId: component.componentId,
          title: component.title,
          type: "filter" as const,
          status: options.size === 0 ? ("empty" as const) : ("ready" as const),
          diagnostics: [],
          bindingId: component.bindingId,
          options: projectedOptions
        };
      }

      return {
        componentId: component.componentId,
        title: component.title,
        type: "text" as const,
        status: "ready" as const,
        diagnostics: [],
        text: component.text
      };
    });

    const manifestSha256 = sha256Hex(canonicalJson(request.manifest));
    const requestSha256 = sha256Hex(canonicalJson(request));
    return DashboardPreviewResponseSchema.parse({
      buildId: `fixture-preview-${requestSha256.slice(0, 16)}`,
      templateId: request.manifest.template.templateId,
      manifestSha256,
      adapterId: this.adapterId,
      generatedAt: this.#now().toISOString(),
      projections,
      diagnostics: responseDiagnostics.slice(0, 1_000)
    });
  }
}
