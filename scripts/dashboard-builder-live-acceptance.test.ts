import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DashboardAcceptanceFailure,
  formatDashboardAcceptanceFailure,
  runDashboardBuilderLocalAcceptance,
  serializeSanitizedDashboardAcceptanceReport
} from "./dashboard-builder-live-acceptance.js";

const TEMPORARY_ROOT_PREFIX = "dashboard-builder-acceptance-";

async function temporaryEvidenceDirectories(): Promise<string[]> {
  const localRoot = resolve(process.cwd(), ".local");
  try {
    return (await readdir(localRoot))
      .filter((name) => name.startsWith(TEMPORARY_ROOT_PREFIX))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

describe("dashboard builder deterministic local acceptance", () => {
  it("exercises the real loopback lifecycle and removes its temporary evidence", async () => {
    const before = await temporaryEvidenceDirectories();

    const report = await runDashboardBuilderLocalAcceptance(process.cwd());

    expect(report).toMatchObject({
      schemaVersion: "dashboard-builder-local-acceptance/v1",
      accepted: true,
      boundary: {
        mode: "tracked-fixture",
        transport: "ephemeral-loopback",
        qlik: "disabled",
        evidence: "temporary-cleaned"
      },
      lifecycle: {
        templateCount: 1,
        componentProjectionCount: 6,
        successfulBuildCount: 4,
        staleConflictCount: 1,
        publishedRevisionCount: 2,
        rollbackRevisionCount: 1,
        recoveredRevisionCount: 3,
        rejectedMaliciousUploadCount: 1,
        finalCurrentRevision: 5,
        activeRevisionNumber: 3
      }
    });
    expect(report.checks).toHaveLength(9);
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(report.runFingerprintSha256).toBe(
      "373a6a1ac7f5c31e28b7d0571c9cc055588d2253240a2fe506057b5765a2362b"
    );
    const after = await temporaryEvidenceDirectories();
    expect(after.filter((name) => !before.includes(name))).toEqual([]);
  }, 30_000);

  it("serializes only the bounded summary and formats failures without causes", async () => {
    const report = await runDashboardBuilderLocalAcceptance(process.cwd());
    const serialized = serializeSanitizedDashboardAcceptanceReport(report);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(16_384);
    expect(serialized).not.toMatch(
      /"(?:manifest|rows|projections|sourceReference|evidenceRoot|temporaryRoot|jsx)"\s*:/iu
    );
    expect(serialized).not.toMatch(/<script|export default|\.local[\\/]dashboard/iu);

    const failure = new DashboardAcceptanceFailure("api-request-failed", {
      cause: new Error("raw private manifest and filesystem detail")
    });
    const formatted = formatDashboardAcceptanceFailure(failure);
    expect(formatted).toBe(
      "Dashboard builder local acceptance failed: A local acceptance request failed its bounded response contract."
    );
    expect(formatted).not.toMatch(/private manifest|filesystem detail/iu);
  }, 30_000);
});
