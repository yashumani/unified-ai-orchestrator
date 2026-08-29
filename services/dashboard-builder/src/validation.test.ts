import type { DashboardManifest } from "@unified-ai/contracts/dashboard-builder";
import { describe, expect, it } from "vitest";
import { loadDashboardSample } from "./sample-loader.js";
import { validateDashboardManifest } from "./validation.js";

async function sample(): Promise<DashboardManifest> {
  return (await loadDashboardSample(process.cwd())).manifest;
}

describe("dashboard manifest semantic validation", () => {
  it("normalizes the tracked sample with a deterministic content hash", async () => {
    const first = validateDashboardManifest(await sample());
    const second = validateDashboardManifest(await sample());

    expect(first.valid).toBe(true);
    expect(first.publishEligible).toBe(true);
    expect(first.diagnostics).toEqual([]);
    expect(first.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.manifestSha256).toBe(first.manifestSha256);
  });

  it("rejects duplicate and unresolved references with JSON Pointer paths", async () => {
    const manifest = await sample();
    const invalid = {
      ...manifest,
      bindings: [...manifest.bindings, manifest.bindings[0]],
      components: manifest.components.map((component, index) =>
        index === 0 && component.type === "kpi"
          ? { ...component, calculationId: "missing-calculation" }
          : component
      )
    };
    const result = validateDashboardManifest(invalid);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate-identifier" }),
        expect.objectContaining({
          code: "unknown-calculation",
          path: "/components/0/calculationId"
        })
      ])
    );
  });

  it("rejects calculation cycles and invalid aggregate operands", async () => {
    const manifest = await sample();
    const invalid = {
      ...manifest,
      calculations: [
        {
          calculationId: "cycle-one",
          label: "Cycle one",
          kind: "portable",
          valueType: "number",
          format: null,
          expression: { kind: "calculation", calculationId: "cycle-two" }
        },
        {
          calculationId: "cycle-two",
          label: "Cycle two",
          kind: "portable",
          valueType: "number",
          format: null,
          expression: {
            kind: "operation",
            operator: "sum",
            operands: [{ kind: "calculation", calculationId: "cycle-one" }]
          }
        }
      ]
    };
    const result = validateDashboardManifest(invalid);

    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["aggregate-binding-required", "calculation-cycle"])
    );
  });

  it("keeps overlap as a draft warning but blocks publish eligibility", async () => {
    const manifest = await sample();
    const first = manifest.layout.large[0];
    const second = manifest.layout.large[1];
    if (first === undefined || second === undefined) {
      throw new Error("sample requires two large placements");
    }
    const result = validateDashboardManifest({
      ...manifest,
      layout: {
        ...manifest.layout,
        large: manifest.layout.large.map((placement, index) =>
          index === 1
            ? { ...placement, x: first.x, y: first.y }
            : placement
        )
      }
    });

    expect(result.valid).toBe(true);
    expect(result.publishEligible).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "layout-overlap" })])
    );
  });

  it("rejects executable fields atomically and never returns a normalized manifest", async () => {
    const manifest = await sample();
    const result = validateDashboardManifest({
      ...manifest,
      jsx: "export default function Dashboard() {}"
    });

    expect(result.valid).toBe(false);
    expect(result.normalizedManifest).toBeNull();
    expect(result.manifestSha256).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "executable-field-prohibited",
        "manifest-schema-invalid"
      ])
    );
  });

  it("requires the separately gated Qlik adapter for Qlik calculations", async () => {
    const manifest = await sample();
    const result = validateDashboardManifest({
      ...manifest,
      calculations: [
        ...manifest.calculations,
        {
          calculationId: "qlik-sales",
          label: "Qlik sales",
          kind: "qlik",
          valueType: "number",
          format: "currency-usd",
          expression: "Sum([Sales])"
        }
      ]
    });

    expect(result.valid).toBe(true);
    expect(result.publishEligible).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "qlik-adapter-required" })
      ])
    );
  });
});
