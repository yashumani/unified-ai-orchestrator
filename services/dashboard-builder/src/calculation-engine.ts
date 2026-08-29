import {
  DASHBOARD_MAX_EXPRESSION_DEPTH,
  DASHBOARD_MAX_EXPRESSION_NODES,
  type DashboardDiagnostic,
  type DashboardExpression,
  type DashboardManifest,
  type DashboardPreviewRequest
} from "@unified-ai/contracts/dashboard-builder";

export type DashboardPrimitive = string | number | boolean | null;
export type DashboardCalculationRow = Readonly<
  Record<string, DashboardPrimitive | undefined>
>;

type DashboardBinding = DashboardManifest["bindings"][number];
type DashboardCalculation = DashboardManifest["calculations"][number];
type EvaluationValue = DashboardPrimitive | readonly DashboardPrimitive[];
type PortableOperator = Extract<
  DashboardExpression,
  { kind: "operation" }
>["operator"];

export interface PortableCalculationOptions {
  bindings: readonly DashboardBinding[];
  calculations: readonly DashboardCalculation[];
  rows: readonly DashboardCalculationRow[];
  parameterValues: DashboardPreviewRequest["parameterValues"];
}

export interface PortableCalculationResult {
  value: DashboardPrimitive;
  diagnostics: DashboardDiagnostic[];
}

export interface PortableCalculationBatchResult {
  values: Readonly<Record<string, DashboardPrimitive>>;
  diagnostics: DashboardDiagnostic[];
}

interface EvaluationContext {
  readonly bindings: ReadonlyMap<string, DashboardBinding>;
  readonly calculations: ReadonlyMap<string, DashboardCalculation>;
  readonly calculationIndexes: ReadonlyMap<string, number>;
  readonly rows: readonly DashboardCalculationRow[];
  readonly parameterValues: DashboardPreviewRequest["parameterValues"];
  readonly cache: Map<string, DashboardPrimitive>;
  readonly active: Set<string>;
  readonly diagnostics: DashboardDiagnostic[];
  readonly diagnosticKeys: Set<string>;
}

function calculationPath(context: EvaluationContext, calculationId: string): string {
  const index = context.calculationIndexes.get(calculationId);
  return index === undefined ? "/calculations" : `/calculations/${String(index)}/expression`;
}

function addDiagnostic(
  context: EvaluationContext,
  diagnostic: DashboardDiagnostic
): void {
  const key = [
    diagnostic.severity,
    diagnostic.code,
    diagnostic.path,
    diagnostic.calculationId ?? "",
    diagnostic.bindingId ?? ""
  ].join("|");
  if (!context.diagnosticKeys.has(key)) {
    context.diagnosticKeys.add(key);
    context.diagnostics.push(diagnostic);
  }
}

function expressionWithinLimits(expression: DashboardExpression): boolean {
  let nodes = 0;
  const pending: Array<{ expression: DashboardExpression; depth: number }> = [
    { expression, depth: 1 }
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    nodes += 1;
    if (
      nodes > DASHBOARD_MAX_EXPRESSION_NODES ||
      current.depth > DASHBOARD_MAX_EXPRESSION_DEPTH
    ) {
      return false;
    }
    if (current.expression.kind === "operation") {
      for (const operand of current.expression.operands) {
        pending.push({ expression: operand, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

function normalizedBindingValue(
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

function scalarValue(value: EvaluationValue): DashboardPrimitive {
  if (!Array.isArray(value)) {
    return value as DashboardPrimitive;
  }
  return value.length === 1 ? value[0] ?? null : null;
}

function numericValue(value: EvaluationValue): number | null {
  const scalar = scalarValue(value);
  return typeof scalar === "number" && Number.isFinite(scalar) ? scalar : null;
}

function aggregateValues(value: EvaluationValue): readonly DashboardPrimitive[] {
  return Array.isArray(value) ? value : [value as DashboardPrimitive];
}

function boundedNumericResult(
  value: number,
  calculationId: string,
  context: EvaluationContext
): number | null {
  if (Number.isFinite(value)) {
    return value;
  }
  addDiagnostic(context, {
    severity: "warning",
    code: "portable-non-finite-result",
    path: calculationPath(context, calculationId),
    message: "Portable arithmetic returned null because its result was not finite.",
    remediation: "Reduce the calculation magnitude or add a bounded fallback.",
    calculationId
  });
  return null;
}

function validArity(operator: PortableOperator, count: number): boolean {
  if (["sum", "count", "min", "max", "average"].includes(operator)) {
    return count === 1;
  }
  if (["difference", "ratio", "multiply"].includes(operator)) {
    return count === 2;
  }
  if (operator === "round") {
    return count === 1 || count === 2;
  }
  return operator === "coalesce" && count >= 1 && count <= 20;
}

function evaluateOperation(
  expression: Extract<DashboardExpression, { kind: "operation" }>,
  calculationId: string,
  context: EvaluationContext
): EvaluationValue {
  if (!validArity(expression.operator, expression.operands.length)) {
    addDiagnostic(context, {
      severity: "error",
      code: "portable-operator-arity",
      path: calculationPath(context, calculationId),
      message: `Portable operator ${expression.operator} has an invalid operand count.`,
      calculationId
    });
    return null;
  }

  const operands = expression.operands.map((operand) =>
    evaluateExpression(operand, calculationId, context)
  );

  if (["sum", "count", "min", "max", "average"].includes(expression.operator)) {
    const values = aggregateValues(operands[0] ?? null);
    if (expression.operator === "count") {
      return values.filter((value) => value !== null).length;
    }
    const numbers = values.filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value)
    );
    if (expression.operator === "sum") {
      return boundedNumericResult(
        numbers.reduce((total, value) => total + value, 0),
        calculationId,
        context
      );
    }
    if (numbers.length === 0) {
      return null;
    }
    if (expression.operator === "min") {
      return Math.min(...numbers);
    }
    if (expression.operator === "max") {
      return Math.max(...numbers);
    }
    return boundedNumericResult(
      numbers.reduce((total, value) => total + value, 0) / numbers.length,
      calculationId,
      context
    );
  }

  if (expression.operator === "coalesce") {
    for (const operand of operands) {
      const value = scalarValue(operand);
      if (value !== null) {
        return value;
      }
    }
    return null;
  }

  const left = numericValue(operands[0] ?? null);
  if (left === null) {
    return null;
  }

  if (expression.operator === "round") {
    const requestedDigits = operands.length === 2 ? numericValue(operands[1] ?? null) : 0;
    if (
      requestedDigits === null ||
      !Number.isInteger(requestedDigits) ||
      requestedDigits < -12 ||
      requestedDigits > 12
    ) {
      addDiagnostic(context, {
        severity: "warning",
        code: "portable-round-digits-invalid",
        path: calculationPath(context, calculationId),
        message: "Portable round digits must be an integer between -12 and 12.",
        calculationId
      });
      return null;
    }
    const factor = 10 ** requestedDigits;
    return boundedNumericResult(
      Math.round((left + Number.EPSILON) * factor) / factor,
      calculationId,
      context
    );
  }

  const right = numericValue(operands[1] ?? null);
  if (right === null) {
    return null;
  }
  if (expression.operator === "difference") {
    return boundedNumericResult(left - right, calculationId, context);
  }
  if (expression.operator === "multiply") {
    return boundedNumericResult(left * right, calculationId, context);
  }
  if (right === 0) {
    addDiagnostic(context, {
      severity: "warning",
      code: "portable-divide-by-zero",
      path: calculationPath(context, calculationId),
      message: "Portable ratio returned null because its divisor was zero.",
      remediation: "Filter zero divisors or use coalesce with a safe fallback.",
      calculationId
    });
    return null;
  }
  return boundedNumericResult(left / right, calculationId, context);
}

function evaluateExpression(
  expression: DashboardExpression,
  calculationId: string,
  context: EvaluationContext
): EvaluationValue {
  if (expression.kind === "literal") {
    return expression.value;
  }
  if (expression.kind === "binding") {
    const binding = context.bindings.get(expression.bindingId);
    if (binding === undefined) {
      addDiagnostic(context, {
        severity: "error",
        code: "portable-binding-missing",
        path: calculationPath(context, calculationId),
        message: `Portable calculation references an unknown binding: ${expression.bindingId}.`,
        calculationId,
        bindingId: expression.bindingId
      });
      return null;
    }
    return context.rows.map((row) => normalizedBindingValue(binding, row));
  }
  if (expression.kind === "parameter") {
    if (!Object.prototype.hasOwnProperty.call(context.parameterValues, expression.parameterId)) {
      addDiagnostic(context, {
        severity: "error",
        code: "portable-parameter-missing",
        path: calculationPath(context, calculationId),
        message: `Portable calculation requires parameter ${expression.parameterId}.`,
        calculationId
      });
      return null;
    }
    return context.parameterValues[expression.parameterId] ?? null;
  }
  if (expression.kind === "calculation") {
    return evaluateCalculationById(expression.calculationId, context);
  }
  return evaluateOperation(expression, calculationId, context);
}

function evaluateCalculationById(
  calculationId: string,
  context: EvaluationContext
): DashboardPrimitive {
  if (context.cache.has(calculationId)) {
    return context.cache.get(calculationId) ?? null;
  }
  if (context.active.has(calculationId)) {
    addDiagnostic(context, {
      severity: "error",
      code: "portable-calculation-cycle",
      path: calculationPath(context, calculationId),
      message: `Portable calculation references form a cycle at ${calculationId}.`,
      remediation: "Remove at least one calculation reference from the cycle.",
      calculationId
    });
    return null;
  }

  const calculation = context.calculations.get(calculationId);
  if (calculation === undefined) {
    addDiagnostic(context, {
      severity: "error",
      code: "portable-calculation-missing",
      path: "/calculations",
      message: `Portable calculation ${calculationId} was not found.`,
      calculationId
    });
    return null;
  }
  if (calculation.kind === "qlik") {
    addDiagnostic(context, {
      severity: "warning",
      code: "qlik-calculation-unavailable",
      path: calculationPath(context, calculationId),
      message: "A Qlik-only calculation cannot be evaluated by the portable engine.",
      remediation: "Use an authorized Qlik adapter for this calculation.",
      calculationId
    });
    context.cache.set(calculationId, null);
    return null;
  }
  if (!expressionWithinLimits(calculation.expression)) {
    addDiagnostic(context, {
      severity: "error",
      code: "portable-expression-limit",
      path: calculationPath(context, calculationId),
      message: "The portable expression exceeds the configured depth or node limit.",
      remediation: "Reduce the number or nesting of expression operands.",
      calculationId
    });
    context.cache.set(calculationId, null);
    return null;
  }

  context.active.add(calculationId);
  const evaluated = evaluateExpression(calculation.expression, calculationId, context);
  context.active.delete(calculationId);
  const value = scalarValue(evaluated);
  if (Array.isArray(evaluated) && evaluated.length !== 1) {
    addDiagnostic(context, {
      severity: "error",
      code: "portable-scalar-required",
      path: calculationPath(context, calculationId),
      message: "A portable calculation must resolve to one scalar value.",
      calculationId
    });
  }
  context.cache.set(calculationId, value);
  return value;
}

function createContext(options: PortableCalculationOptions): EvaluationContext {
  return {
    bindings: new Map(options.bindings.map((binding) => [binding.bindingId, binding])),
    calculations: new Map(
      options.calculations.map((calculation) => [calculation.calculationId, calculation])
    ),
    calculationIndexes: new Map(
      options.calculations.map((calculation, index) => [calculation.calculationId, index])
    ),
    rows: options.rows,
    parameterValues: options.parameterValues,
    cache: new Map(),
    active: new Set(),
    diagnostics: [],
    diagnosticKeys: new Set()
  };
}

export function evaluatePortableCalculation(
  calculationId: string,
  options: PortableCalculationOptions
): PortableCalculationResult {
  const context = createContext(options);
  const value = evaluateCalculationById(calculationId, context);
  return { value, diagnostics: context.diagnostics };
}

export function evaluatePortableCalculations(
  options: PortableCalculationOptions
): PortableCalculationBatchResult {
  const context = createContext(options);
  const values: Record<string, DashboardPrimitive> = {};
  const calculationIds = [...context.calculations.keys()].sort((left, right) =>
    left.localeCompare(right)
  );
  for (const calculationId of calculationIds) {
    values[calculationId] = evaluateCalculationById(calculationId, context);
  }
  return { values, diagnostics: context.diagnostics };
}
