import type { DashboardManifest } from "@unified-ai/contracts/dashboard-builder";
import { describe, expect, it } from "vitest";
import {
  evaluatePortableCalculation,
  evaluatePortableCalculations
} from "./calculation-engine.js";

type Binding = DashboardManifest["bindings"][number];
type Calculation = DashboardManifest["calculations"][number];

const amountBinding: Binding = {
  bindingId: "amount",
  sourceField: "source-amount",
  role: "measure-input",
  valueType: "number",
  format: null,
  nullHandling: "exclude"
};

function portable(
  calculationId: string,
  expression: Extract<Calculation, { kind: "portable" }>["expression"]
): Calculation {
  return {
    calculationId,
    label: calculationId,
    kind: "portable",
    valueType: "number",
    format: null,
    expression
  };
}

describe("portable calculation engine", () => {
  it("evaluates every aggregate with the documented null and numeric rules", () => {
    const calculations: Calculation[] = [
      portable("sum-amount", {
        kind: "operation",
        operator: "sum",
        operands: [{ kind: "binding", bindingId: "amount" }]
      }),
      portable("count-amount", {
        kind: "operation",
        operator: "count",
        operands: [{ kind: "binding", bindingId: "amount" }]
      }),
      portable("min-amount", {
        kind: "operation",
        operator: "min",
        operands: [{ kind: "binding", bindingId: "amount" }]
      }),
      portable("max-amount", {
        kind: "operation",
        operator: "max",
        operands: [{ kind: "binding", bindingId: "amount" }]
      }),
      portable("average-amount", {
        kind: "operation",
        operator: "average",
        operands: [{ kind: "binding", bindingId: "amount" }]
      })
    ];

    const result = evaluatePortableCalculations({
      bindings: [amountBinding],
      calculations,
      rows: [
        { "source-amount": 10 },
        { "source-amount": null },
        { "source-amount": "not-numeric" },
        { "source-amount": 5 }
      ],
      parameterValues: {}
    });

    expect(result.values).toEqual({
      "average-amount": 7.5,
      "count-amount": 3,
      "max-amount": 10,
      "min-amount": 5,
      "sum-amount": 15
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("supports calculation and parameter references plus deterministic scalar operations", () => {
    const calculations: Calculation[] = [
      portable("base", {
        kind: "operation",
        operator: "sum",
        operands: [{ kind: "binding", bindingId: "amount" }]
      }),
      portable("net", {
        kind: "operation",
        operator: "difference",
        operands: [
          { kind: "calculation", calculationId: "base" },
          { kind: "parameter", parameterId: "discount" }
        ]
      }),
      portable("scaled", {
        kind: "operation",
        operator: "multiply",
        operands: [
          { kind: "calculation", calculationId: "net" },
          { kind: "literal", value: 1.25 }
        ]
      }),
      portable("ratio-result", {
        kind: "operation",
        operator: "ratio",
        operands: [
          { kind: "calculation", calculationId: "scaled" },
          { kind: "literal", value: 2 }
        ]
      }),
      portable("rounded", {
        kind: "operation",
        operator: "round",
        operands: [
          { kind: "calculation", calculationId: "ratio-result" },
          { kind: "literal", value: 1 }
        ]
      }),
      portable("fallback", {
        kind: "operation",
        operator: "coalesce",
        operands: [
          { kind: "literal", value: null },
          { kind: "calculation", calculationId: "rounded" }
        ]
      })
    ];

    const result = evaluatePortableCalculation("fallback", {
      bindings: [amountBinding],
      calculations,
      rows: [{ "source-amount": 10 }, { "source-amount": 5 }],
      parameterValues: { discount: 2 }
    });

    expect(result.value).toBe(8.1);
    expect(result.diagnostics).toEqual([]);
  });

  it("propagates null through scalar arithmetic", () => {
    const result = evaluatePortableCalculation("nullable", {
      bindings: [amountBinding],
      calculations: [
        portable("nullable", {
          kind: "operation",
          operator: "difference",
          operands: [
            { kind: "literal", value: null },
            { kind: "literal", value: 3 }
          ]
        })
      ],
      rows: [],
      parameterValues: {}
    });

    expect(result).toEqual({ value: null, diagnostics: [] });
  });

  it("returns null and one stable warning when a ratio divides by zero", () => {
    const result = evaluatePortableCalculation("ratio", {
      bindings: [amountBinding],
      calculations: [
        portable("ratio", {
          kind: "operation",
          operator: "ratio",
          operands: [
            { kind: "literal", value: 10 },
            { kind: "literal", value: 0 }
          ]
        })
      ],
      rows: [],
      parameterValues: {}
    });

    expect(result.value).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "portable-divide-by-zero",
        calculationId: "ratio"
      })
    ]);
  });

  it("converts non-finite arithmetic results to a bounded null warning", () => {
    const result = evaluatePortableCalculation("overflow", {
      bindings: [amountBinding],
      calculations: [
        portable("overflow", {
          kind: "operation",
          operator: "multiply",
          operands: [
            { kind: "literal", value: Number.MAX_VALUE },
            { kind: "literal", value: 2 }
          ]
        })
      ],
      rows: [],
      parameterValues: {}
    });

    expect(result.value).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "portable-non-finite-result",
        calculationId: "overflow"
      })
    ]);
  });

  it("never fabricates values for Qlik-only calculations", () => {
    const result = evaluatePortableCalculation("qlik-only", {
      bindings: [amountBinding],
      calculations: [
        {
          calculationId: "qlik-only",
          label: "Qlik only",
          kind: "qlik",
          valueType: "number",
          format: null,
          expression: "Sum([Sales])"
        }
      ],
      rows: [{ "source-amount": 100 }],
      parameterValues: {}
    });

    expect(result.value).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "qlik-calculation-unavailable",
        calculationId: "qlik-only"
      })
    ]);
  });

  it("rejects calculation cycles without recursing indefinitely", () => {
    const calculations: Calculation[] = [
      portable("cycle-a", { kind: "calculation", calculationId: "cycle-b" }),
      portable("cycle-b", { kind: "calculation", calculationId: "cycle-a" })
    ];

    const result = evaluatePortableCalculation("cycle-a", {
      bindings: [amountBinding],
      calculations,
      rows: [],
      parameterValues: {}
    });

    expect(result.value).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "portable-calculation-cycle",
        calculationId: "cycle-a"
      })
    ]);
  });

  it("enforces the expression node limit even for unchecked callers", () => {
    const operands = Array.from({ length: 257 }, () => ({
      kind: "literal" as const,
      value: 1
    }));
    const unchecked = portable("too-large", {
      kind: "operation",
      operator: "coalesce",
      operands
    });

    const result = evaluatePortableCalculation("too-large", {
      bindings: [amountBinding],
      calculations: [unchecked],
      rows: [],
      parameterValues: {}
    });

    expect(result.value).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "portable-expression-limit",
        calculationId: "too-large"
      })
    ]);
  });
});
