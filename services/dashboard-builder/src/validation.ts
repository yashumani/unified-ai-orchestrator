import {
  DashboardManifestSchema,
  DashboardValidationResultSchema,
  type DashboardDiagnostic,
  type DashboardExpression,
  type DashboardManifest,
  type DashboardValidationResult
} from "@unified-ai/contracts/dashboard-builder";
import { canonicalJson, sha256Hex } from "@unified-ai/evidence-index";
import type { z } from "zod";

const PROHIBITED_KEYS = new Set([
  "css",
  "dependencies",
  "devdependencies",
  "html",
  "javascript",
  "jsx",
  "package",
  "packages",
  "scripts",
  "sql",
  "typescript",
  "wasm"
]);
const PROHIBITED_VALUE = /(?:<script\b|javascript:|data:(?:application|image)\/|^UEsDB)/iu;
const PUBLISH_BLOCKING_WARNINGS = new Set([
  "external-license-review-required",
  "layout-overlap",
  "qlik-adapter-required"
]);

function pointer(path: readonly PropertyKey[]): string {
  return path
    .map((segment) =>
      `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`
    )
    .join("");
}

function structuralDiagnostics(input: unknown): DashboardDiagnostic[] {
  const diagnostics: DashboardDiagnostic[] = [];
  const pending: Array<{ value: unknown; path: PropertyKey[] }> = [
    { value: input, path: [] }
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    if (typeof current.value === "string" && PROHIBITED_VALUE.test(current.value)) {
      diagnostics.push({
        severity: "error",
        code: "executable-content-prohibited",
        path: pointer(current.path),
        message: "Executable, encoded, or inline resource content is not allowed.",
        remediation: "Use declarative dashboard fields and plain text only."
      });
      continue;
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((value, index) => {
        pending.push({ value, path: [...current.path, index] });
      });
      continue;
    }
    if (typeof current.value !== "object" || current.value === null) {
      continue;
    }
    for (const [key, value] of Object.entries(current.value)) {
      if (PROHIBITED_KEYS.has(key.toLowerCase())) {
        diagnostics.push({
          severity: "error",
          code: "executable-field-prohibited",
          path: pointer([...current.path, key]),
          message: `The field ${key} is not allowed in a dashboard manifest.`,
          remediation: "Use an allowlisted manifest field instead."
        });
      } else {
        pending.push({ value, path: [...current.path, key] });
      }
    }
  }
  return diagnostics;
}

function zodDiagnostics(error: z.ZodError): DashboardDiagnostic[] {
  return error.issues.map((issue) => ({
    severity: "error" as const,
    code:
      issue.path.length === 1 &&
      issue.path[0] === "schemaVersion"
        ? "unsupported-schema-version"
        : "manifest-schema-invalid",
    path: pointer(issue.path),
    message: issue.message.slice(0, 2_000),
    remediation: "Correct the manifest value at this JSON path."
  }));
}

function pushDuplicateDiagnostics(
  diagnostics: DashboardDiagnostic[],
  values: readonly string[],
  collection: string,
  field: string
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      diagnostics.push({
        severity: "error",
        code: "duplicate-identifier",
        path: `/${collection}/${String(index)}/${field}`,
        message: `${field} values must be unique.`,
        remediation: "Choose a unique lowercase identifier."
      });
    }
    seen.add(value);
  });
}

function expressionReferences(expression: DashboardExpression): {
  bindings: Set<string>;
  parameters: Set<string>;
  calculations: Set<string>;
  operators: Array<{ operator: string; operands: DashboardExpression[] }>;
} {
  const result = {
    bindings: new Set<string>(),
    parameters: new Set<string>(),
    calculations: new Set<string>(),
    operators: [] as Array<{ operator: string; operands: DashboardExpression[] }>
  };
  const pending = [expression];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      continue;
    }
    if (current.kind === "binding") {
      result.bindings.add(current.bindingId);
    } else if (current.kind === "parameter") {
      result.parameters.add(current.parameterId);
    } else if (current.kind === "calculation") {
      result.calculations.add(current.calculationId);
    } else if (current.kind === "operation") {
      result.operators.push({
        operator: current.operator,
        operands: current.operands
      });
      pending.push(...current.operands);
    }
  }
  return result;
}

function operatorArity(operator: string, count: number): boolean {
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

function referenceDiagnostic(options: {
  kind: "binding" | "calculation" | "parameter" | "component";
  id: string;
  path: string;
}): DashboardDiagnostic {
  return {
    severity: "error",
    code: `unknown-${options.kind}`,
    path: options.path,
    message: `The referenced ${options.kind} ${options.id} does not exist.`,
    remediation: `Choose an existing ${options.kind} identifier.`
  };
}

function hasCalculationCycle(edges: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  let cycle: string[] = [];
  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      cycle = [...stack.slice(Math.max(0, start)), id];
      return true;
    }
    if (visited.has(id)) {
      return false;
    }
    visiting.add(id);
    stack.push(id);
    for (const target of edges.get(id) ?? []) {
      if (edges.has(target) && visit(target)) {
        return true;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of edges.keys()) {
    if (visit(id)) {
      break;
    }
  }
  return cycle;
}

function overlaps(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  );
}

function semanticDiagnostics(manifest: DashboardManifest): DashboardDiagnostic[] {
  const diagnostics: DashboardDiagnostic[] = [];
  const bindingIds = new Set(manifest.bindings.map((binding) => binding.bindingId));
  const parameterIds = new Set(
    manifest.parameters.map((parameter) => parameter.parameterId)
  );
  const calculationIds = new Set(
    manifest.calculations.map((calculation) => calculation.calculationId)
  );
  const componentIds = new Set(
    manifest.components.map((component) => component.componentId)
  );

  pushDuplicateDiagnostics(
    diagnostics,
    manifest.parameters.map((value) => value.parameterId),
    "parameters",
    "parameterId"
  );
  pushDuplicateDiagnostics(
    diagnostics,
    manifest.bindings.map((value) => value.bindingId),
    "bindings",
    "bindingId"
  );
  pushDuplicateDiagnostics(
    diagnostics,
    manifest.calculations.map((value) => value.calculationId),
    "calculations",
    "calculationId"
  );
  pushDuplicateDiagnostics(
    diagnostics,
    manifest.components.map((value) => value.componentId),
    "components",
    "componentId"
  );
  pushDuplicateDiagnostics(
    diagnostics,
    manifest.interactions.map((value) => value.interactionId),
    "interactions",
    "interactionId"
  );

  manifest.parameters.forEach((parameter, index) => {
    if (parameter.type === "number") {
      if (parameter.minimum !== null && parameter.defaultValue < parameter.minimum) {
        diagnostics.push({
          severity: "error",
          code: "parameter-default-out-of-range",
          path: `/parameters/${String(index)}/defaultValue`,
          message: "The default value is lower than the allowed minimum."
        });
      }
      if (parameter.maximum !== null && parameter.defaultValue > parameter.maximum) {
        diagnostics.push({
          severity: "error",
          code: "parameter-default-out-of-range",
          path: `/parameters/${String(index)}/defaultValue`,
          message: "The default value is higher than the allowed maximum."
        });
      }
    }
    if (
      parameter.type === "enum" &&
      !parameter.choices.includes(parameter.defaultValue)
    ) {
      diagnostics.push({
        severity: "error",
        code: "parameter-default-not-allowed",
        path: `/parameters/${String(index)}/defaultValue`,
        message: "The enum default value must appear in choices."
      });
    }
  });

  const calculationEdges = new Map<string, Set<string>>();
  manifest.calculations.forEach((calculation, index) => {
    if (calculation.kind === "qlik") {
      if (manifest.runtime.preferredAdapter !== "qlik") {
        diagnostics.push({
          severity: "warning",
          code: "qlik-adapter-required",
          path: `/calculations/${String(index)}/expression`,
          message: "This calculation requires the Qlik adapter.",
          remediation: "Select an authorized Qlik adapter before publishing.",
          calculationId: calculation.calculationId
        });
      }
      calculationEdges.set(calculation.calculationId, new Set());
      return;
    }
    const references = expressionReferences(calculation.expression);
    calculationEdges.set(calculation.calculationId, references.calculations);
    for (const id of references.bindings) {
      if (!bindingIds.has(id)) {
        diagnostics.push(
          referenceDiagnostic({
            kind: "binding",
            id,
            path: `/calculations/${String(index)}/expression`
          })
        );
      }
    }
    for (const id of references.parameters) {
      if (!parameterIds.has(id)) {
        diagnostics.push(
          referenceDiagnostic({
            kind: "parameter",
            id,
            path: `/calculations/${String(index)}/expression`
          })
        );
      }
    }
    for (const id of references.calculations) {
      if (!calculationIds.has(id)) {
        diagnostics.push(
          referenceDiagnostic({
            kind: "calculation",
            id,
            path: `/calculations/${String(index)}/expression`
          })
        );
      }
    }
    for (const operator of references.operators) {
      if (!operatorArity(operator.operator, operator.operands.length)) {
        diagnostics.push({
          severity: "error",
          code: "operator-arity-invalid",
          path: `/calculations/${String(index)}/expression`,
          message: `Operator ${operator.operator} has an invalid operand count.`,
          calculationId: calculation.calculationId
        });
      }
      if (
        ["sum", "count", "min", "max", "average"].includes(
          operator.operator
        ) &&
        operator.operands[0]?.kind !== "binding"
      ) {
        diagnostics.push({
          severity: "error",
          code: "aggregate-binding-required",
          path: `/calculations/${String(index)}/expression`,
          message: `Operator ${operator.operator} requires one binding operand.`,
          calculationId: calculation.calculationId
        });
      }
    }
  });
  const cycle = hasCalculationCycle(calculationEdges);
  if (cycle.length > 0) {
    diagnostics.push({
      severity: "error",
      code: "calculation-cycle",
      path: "/calculations",
      message: `Calculation references form a cycle: ${cycle.join(" -> ")}.`,
      remediation: "Remove at least one calculation reference from the cycle."
    });
  }

  manifest.components.forEach((component, index) => {
    const base = `/components/${String(index)}`;
    if (component.adapter === "qlik" && manifest.runtime.preferredAdapter !== "qlik") {
      diagnostics.push({
        severity: "warning",
        code: "qlik-adapter-required",
        path: `${base}/adapter`,
        message: "This component requires the Qlik adapter.",
        componentId: component.componentId
      });
    }
    if (component.type === "kpi" && !calculationIds.has(component.calculationId)) {
      diagnostics.push(
        referenceDiagnostic({
          kind: "calculation",
          id: component.calculationId,
          path: `${base}/calculationId`
        })
      );
    } else if (component.type === "data-table") {
      const columnIds = component.columns.map((column) => column.columnId);
      pushDuplicateDiagnostics(diagnostics, columnIds, `components/${String(index)}/columns`, "columnId");
      component.columns.forEach((column, columnIndex) => {
        const ids = column.source.kind === "binding" ? bindingIds : calculationIds;
        if (!ids.has(column.source.id)) {
          diagnostics.push(
            referenceDiagnostic({
              kind: column.source.kind,
              id: column.source.id,
              path: `${base}/columns/${String(columnIndex)}/source/id`
            })
          );
        }
      });
    } else if (component.type === "bar-chart" || component.type === "line-chart") {
      if (!bindingIds.has(component.dimensionBindingId)) {
        diagnostics.push(
          referenceDiagnostic({
            kind: "binding",
            id: component.dimensionBindingId,
            path: `${base}/dimensionBindingId`
          })
        );
      }
      component.calculationIds.forEach((id, calculationIndex) => {
        if (!calculationIds.has(id)) {
          diagnostics.push(
            referenceDiagnostic({
              kind: "calculation",
              id,
              path: `${base}/calculationIds/${String(calculationIndex)}`
            })
          );
        }
      });
    } else if (component.type === "filter" && !bindingIds.has(component.bindingId)) {
      diagnostics.push(
        referenceDiagnostic({
          kind: "binding",
          id: component.bindingId,
          path: `${base}/bindingId`
        })
      );
    }
  });

  manifest.interactions.forEach((interaction, index) => {
    const base = `/interactions/${String(index)}`;
    if (!componentIds.has(interaction.sourceComponentId)) {
      diagnostics.push(
        referenceDiagnostic({
          kind: "component",
          id: interaction.sourceComponentId,
          path: `${base}/sourceComponentId`
        })
      );
    }
    if ("targetComponentId" in interaction && !componentIds.has(interaction.targetComponentId)) {
      diagnostics.push(
        referenceDiagnostic({
          kind: "component",
          id: interaction.targetComponentId,
          path: `${base}/targetComponentId`
        })
      );
    }
    if ("targetBindingId" in interaction && !bindingIds.has(interaction.targetBindingId)) {
      diagnostics.push(
        referenceDiagnostic({
          kind: "binding",
          id: interaction.targetBindingId,
          path: `${base}/targetBindingId`
        })
      );
    }
  });

  for (const breakpoint of ["large", "medium", "small"] as const) {
    const placements = manifest.layout[breakpoint];
    pushDuplicateDiagnostics(
      diagnostics,
      placements.map((placement) => placement.componentId),
      `layout/${breakpoint}`,
      "componentId"
    );
    placements.forEach((placement, index) => {
      if (!componentIds.has(placement.componentId)) {
        diagnostics.push(
          referenceDiagnostic({
            kind: "component",
            id: placement.componentId,
            path: `/layout/${breakpoint}/${String(index)}/componentId`
          })
        );
      }
      if (placement.x + placement.width > manifest.layout.columns) {
        diagnostics.push({
          severity: "error",
          code: "layout-out-of-bounds",
          path: `/layout/${breakpoint}/${String(index)}`,
          message: "The component extends beyond the 12-column layout."
        });
      }
      for (let otherIndex = index + 1; otherIndex < placements.length; otherIndex += 1) {
        const other = placements[otherIndex];
        if (other !== undefined && overlaps(placement, other)) {
          diagnostics.push({
            severity: "warning",
            code: "layout-overlap",
            path: `/layout/${breakpoint}/${String(otherIndex)}`,
            message: `Components ${placement.componentId} and ${other.componentId} overlap.`,
            remediation: "Move or resize one component before publishing."
          });
        }
      }
    });
    for (const componentId of componentIds) {
      if (!placements.some((placement) => placement.componentId === componentId)) {
        diagnostics.push({
          severity: "error",
          code: "layout-component-missing",
          path: `/layout/${breakpoint}`,
          message: `Component ${componentId} is missing from the ${breakpoint} layout.`,
          componentId
        });
      }
    }
  }

  if (manifest.provenance.source === "qlik-object-metadata") {
    diagnostics.push({
      severity: "warning",
      code: "external-license-review-required",
      path: "/provenance/source",
      message: "External visualization metadata requires compatibility and licensing review.",
      remediation: "Confirm documented Qlik metadata use and any Vizlib rights before publishing."
    });
  }

  return diagnostics;
}

function sortDiagnostics(diagnostics: DashboardDiagnostic[]): DashboardDiagnostic[] {
  const severityOrder = { error: 0, warning: 1, info: 2 } as const;
  return diagnostics.sort((left, right) =>
    severityOrder[left.severity] - severityOrder[right.severity] ||
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code)
  );
}

export function validateDashboardManifest(input: unknown): DashboardValidationResult {
  const prohibited = structuralDiagnostics(input);
  const parsed = DashboardManifestSchema.safeParse(input);
  if (!parsed.success) {
    return DashboardValidationResultSchema.parse({
      schemaVersion: "dashboard-validation/v1",
      valid: false,
      publishEligible: false,
      normalizedManifest: null,
      manifestSha256: null,
      diagnostics: sortDiagnostics([...prohibited, ...zodDiagnostics(parsed.error)])
    });
  }

  const diagnostics = sortDiagnostics([
    ...prohibited,
    ...semanticDiagnostics(parsed.data)
  ]);
  const valid = !diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const publishEligible =
    valid &&
    !diagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "warning" &&
        PUBLISH_BLOCKING_WARNINGS.has(diagnostic.code)
    );
  const normalizedManifest = valid ? parsed.data : null;
  return DashboardValidationResultSchema.parse({
    schemaVersion: "dashboard-validation/v1",
    valid,
    publishEligible,
    normalizedManifest,
    manifestSha256:
      normalizedManifest === null
        ? null
        : sha256Hex(canonicalJson(normalizedManifest)),
    diagnostics
  });
}
