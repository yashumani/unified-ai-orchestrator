import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAuditReport } from "./release/check-npm-audit.mjs";

function fixture() {
  const vulnerableNodes = [
    "node_modules/@ai-sdk/google-vertex/node_modules/undici",
    "node_modules/@ai-sdk/openai-compatible/node_modules/undici"
  ];
  const packages = {
    "node_modules/@copilotkit/runtime": {
      version: "1.69.3",
      dependencies: { "@ai-sdk/google-vertex": "^3.0.97" }
    },
    "node_modules/@ai-sdk/google-vertex": {
      version: "3.0.170",
      dependencies: {
        "@ai-sdk/openai-compatible": "1.0.52",
        "@ai-sdk/provider-utils": "3.0.35"
      }
    },
    "node_modules/@ai-sdk/openai-compatible": {
      version: "1.0.52",
      dependencies: { "@ai-sdk/provider-utils": "3.0.35" }
    }
  };
  for (const node of vulnerableNodes) {
    packages[node] = { version: "5.29.0" };
    packages[node.replace(/\/undici$/u, "/@ai-sdk/provider-utils")] = {
      version: "3.0.35",
      dependencies: { undici: "^5.29.0" }
    };
  }
  return {
    audit: {
      auditReportVersion: 2,
      vulnerabilities: {
        undici: {
          severity: "high",
          isDirect: false,
          nodes: vulnerableNodes,
          effects: ["@ai-sdk/provider-utils"],
          via: [1114638, 1114640, 1121245].map((source) => ({ source, severity: "high" }))
        }
      },
      metadata: {
        vulnerabilities: { info: 0, low: 4, moderate: 1, high: 1, critical: 0, total: 6 }
      }
    },
    lock: { lockfileVersion: 3, packages },
    apiPackage: { dependencies: { "@copilotkit/runtime": "1.69.3" } }
  };
}

describe("controlled production dependency audit gate", () => {
  const commitSha = "a".repeat(40);
  it("keeps the executable exception documented and bounded to local deployment", async () => {
    const documentation = await readFile(
      resolve("scripts/release/KNOWN_AUDIT_EXCEPTION.md"),
      "utf8"
    );
    expect(documentation).toContain("copilotkit-google-vertex-undici-2026-08-29");
    expect(documentation).toContain("zero critical vulnerabilities");
    expect(documentation).toMatch(/does not authorize a\s+public or cloud deployment/u);
    expect(documentation).toContain("2026-09-29");
  });

  it("accepts only the documented transitive undici chain", () => {
    const input = fixture();
    const receipt = evaluateAuditReport(input.audit, input.lock, input.apiPackage, commitSha);
    expect(receipt.accepted).toBe(true);
    expect(receipt.commitSha).toBe(commitSha);
    expect(receipt.observed).toMatchObject({ high: 1, critical: 0 });
  });

  it("rejects any critical vulnerability", () => {
    const input = fixture();
    input.audit.metadata.vulnerabilities.critical = 1;
    expect(() => evaluateAuditReport(input.audit, input.lock, input.apiPackage, commitSha)).toThrow(
      /Critical production vulnerabilities are forbidden/u
    );
  });

  it("rejects another high-severity package", () => {
    const input = fixture();
    input.audit.vulnerabilities.other = { severity: "high" };
    input.audit.metadata.vulnerabilities.high = 2;
    expect(() => evaluateAuditReport(input.audit, input.lock, input.apiPackage, commitSha)).toThrow(
      /Unexpected high\/critical/u
    );
  });

  it("rejects dependency or advisory drift within the exception", () => {
    const dependencyDrift = fixture();
    dependencyDrift.lock.packages["node_modules/@ai-sdk/google-vertex"].version = "3.0.171";
    expect(() =>
      evaluateAuditReport(
        dependencyDrift.audit,
        dependencyDrift.lock,
        dependencyDrift.apiPackage,
        commitSha
      )
    ).toThrow(/changed from 3\.0\.170/u);

    const advisoryDrift = fixture();
    advisoryDrift.audit.vulnerabilities.undici.via.push({ source: 9999999, severity: "high" });
    expect(() =>
      evaluateAuditReport(advisoryDrift.audit, advisoryDrift.lock, advisoryDrift.apiPackage, commitSha)
    ).toThrow(/known high-severity undici advisories changed/u);
  });
});
