import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSanitizedAcceptanceReport,
  formatSecretSafeFailure,
  serializeSanitizedReport,
  type PortfolioAcceptanceObservation
} from "./portfolio-live-acceptance.js";

const OBSERVED_AT = "2026-08-29T04:30:00.000Z";
const PRIVATE_MARKER = "fixture-owner/private-repository-one";
const SECRET = "github_pat_fixture-secret-value-that-must-not-escape";

function observation(): PortfolioAcceptanceObservation {
  const repositories = [1, 2, 3].map((number) => ({
    repositoryId: `repository-${number}`,
    fullName: number === 1 ? PRIVATE_MARKER : `fixture-owner/source-${number}`,
    recommendationAction: "keep-standalone",
    citations: [
      {
        citationId: `citation-${number}`,
        locator: `private/path/${number}`,
        statement: `Raw evidence ${number}`
      }
    ]
  }));
  const recommendations = repositories.map((repository, index) => ({
    recommendationId: `recommendation-${index + 1}`,
    repositoryIds: [repository.repositoryId],
    citationIds: [`citation-${index + 1}`],
    rationale: `Private rationale for ${repository.fullName}`,
    decisionHistory: [
      {
        eventId: `decision-${index + 1}-0`,
        recommendationId: `recommendation-${index + 1}`,
        runId: "portfolio-run-live-fixture",
        sequence: 0
      }
    ]
  }));

  return {
    expectedBranch: "feature/portfolio-rationalization",
    actualBranch: "feature/portfolio-rationalization",
    expectedSourceCount: 3,
    observedAt: OBSERVED_AT,
    ollama: {
      pinnedModel: "qwen3:4b",
      pinnedModelAvailable: true,
      inventoryCount: 2
    },
    run: {
      runId: "portfolio-run-live-fixture",
      status: "succeeded",
      createdAt: "2026-08-29T04:20:00.000Z",
      completedAt: "2026-08-29T04:29:00.000Z",
      repositoryCount: 3,
      warningCount: 0,
      revisionMismatchCount: 0
    },
    repositories,
    clusters: [
      {
        clusterId: "cluster-one-two",
        repositoryIds: ["repository-1", "repository-2"],
        citationIds: ["citation-1", "citation-2"]
      }
    ],
    recommendations
  };
}

describe("portfolio live acceptance report validation", () => {
  test("accepts complete coverage and derives clustered versus standalone counts", () => {
    const report = buildSanitizedAcceptanceReport(observation());

    assert.equal(report.accepted, true);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.coverage, {
      expectedSourceCount: 3,
      sourceProjectionCount: 3,
      recommendationCount: 3,
      recommendationCoverageCount: 3,
      clusteredSourceCount: 2,
      standaloneSourceCount: 1,
      citationBearingSourceCount: 3,
      citationBearingRecommendationCount: 3,
      decisionHistoryBearingRecommendationCount: 3,
      decisionEventCount: 3
    });

    const serialized = serializeSanitizedReport(report, [SECRET]);
    assert.doesNotMatch(serialized, /fixture-owner|private-repository|Raw evidence/u);
    assert.doesNotMatch(serialized, /locator|statement|rationale|fullName/u);
  });

  test("fails closed for count, revision, citation, assignment, and history gaps", () => {
    const input = observation();
    input.run.status = "failed";
    input.run.revisionMismatchCount = 1;
    input.repositories.pop();
    input.repositories[0]!.recommendationAction = undefined;
    input.repositories[0]!.citations = [];
    input.clusters[0]!.repositoryIds = ["repository-1", "repository-unknown"];
    input.recommendations.pop();
    input.recommendations[0]!.citationIds = [];
    input.recommendations[0]!.decisionHistory = [];

    const report = buildSanitizedAcceptanceReport(input);
    const failureCodes = report.failures.map((failure) => failure.code);

    assert.equal(report.accepted, false);
    assert.ok(failureCodes.includes("run-not-succeeded"));
    assert.ok(failureCodes.includes("source-count-mismatch"));
    assert.ok(failureCodes.includes("revision-mismatch"));
    assert.ok(failureCodes.includes("recommendation-count-mismatch"));
    assert.ok(failureCodes.includes("recommendation-coverage-incomplete"));
    assert.ok(failureCodes.includes("source-citations-missing"));
    assert.ok(failureCodes.includes("recommendation-citations-missing"));
    assert.ok(failureCodes.includes("decision-history-invalid"));
    assert.ok(failureCodes.includes("cluster-membership-invalid"));
  });

  test("rejects non-append-only decision histories", () => {
    const input = observation();
    input.recommendations[0]!.decisionHistory.push({
      eventId: "decision-1-2",
      recommendationId: "recommendation-1",
      runId: input.run.runId,
      sequence: 2
    });

    const report = buildSanitizedAcceptanceReport(input);

    assert.equal(report.accepted, false);
    assert.ok(
      report.failures.some((failure) => failure.code === "decision-history-invalid")
    );
  });
});

describe("secret-safe operator output", () => {
  test("never renders an unexpected error message or credential", () => {
    const output = formatSecretSafeFailure(
      new Error(`request failed for ${PRIVATE_MARKER} with ${SECRET}`)
    );

    assert.equal(
      output,
      "Portfolio live acceptance failed before a sanitized result was available."
    );
    assert.doesNotMatch(output, /fixture-owner|github_pat_|private-repository/u);
  });

  test("refuses to serialize an explicitly supplied secret value", () => {
    const report = buildSanitizedAcceptanceReport(observation());
    const contaminated = {
      ...report,
      accidental: SECRET
    };

    assert.throws(
      () => serializeSanitizedReport(contaminated as never, [SECRET]),
      (error: unknown) =>
        formatSecretSafeFailure(error) ===
        "Portfolio live acceptance failed: sanitized output safety check failed."
    );
  });
});
