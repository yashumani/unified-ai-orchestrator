import {
  RECOMMENDATION_CONFIDENCE_WEIGHTS,
  SCHEMA_VERSION,
  type EvidenceFamily,
  type RecommendationAction,
  type RepositoryCitation
} from "@unified-ai/contracts";
import { describe, expect, test } from "vitest";
import {
  calculateConfidence,
  classifierAgreement,
  compareProfiles,
  eligibleRecommendationActions,
  evaluateRecommendation,
  REQUIRED_EVIDENCE_FAMILIES,
  type ClassifierProposal,
  type DeterministicRepositoryProfile
} from "./index.js";

const SHA = "a".repeat(40);
const OBJECT_SHA = "b".repeat(64);

function familyStates(
  incomplete?: EvidenceFamily
): DeterministicRepositoryProfile["evidenceFamilies"] {
  return Object.fromEntries(
    REQUIRED_EVIDENCE_FAMILIES.map((family) => [
      family,
      family === incomplete ? "incomplete" : "complete"
    ])
  ) as DeterministicRepositoryProfile["evidenceFamilies"];
}

function citation(repositoryId: string, citationId: string): RepositoryCitation {
  return {
    schemaVersion: SCHEMA_VERSION,
    citationId,
    family: "documentation",
    repositoryId,
    capturedRevision: SHA,
    capturedAt: "2026-08-28T12:00:00.000Z",
    evidenceObjectSha256: OBJECT_SHA,
    locator: "README.md#purpose",
    statement: "Repository purpose evidence."
  };
}

function profile(
  repositoryId: string,
  overrides: Partial<DeterministicRepositoryProfile> = {}
): DeterministicRepositoryProfile {
  return {
    binding: {
      repositoryId,
      capturedRevision: SHA,
      capturedAt: "2026-08-28T12:00:00.000Z",
      evidenceObjectSha256: OBJECT_SHA
    },
    fullName: `fixture-owner/${repositoryId}`,
    purpose: "local AI orchestration",
    capabilities: ["orchestration", "evidence", "local model runtime"],
    technologyTags: ["typescript"],
    evidenceFamilies: familyStates(),
    citations: [citation(repositoryId, `citation-${repositoryId}`)],
    contradictions: [],
    visibility: "public",
    licenseSpdxId: "MIT",
    archived: false,
    openWorkItemCount: 1,
    lastCommitAt: "2026-08-27T12:00:00.000Z",
    isOrchestrator: false,
    supersededByRepositoryId: null,
    ...overrides
  };
}

function proposal(
  repositoryId: string,
  action: RecommendationAction,
  purpose = "local AI orchestration"
): ClassifierProposal {
  return {
    purpose,
    action,
    rationale: "The repositories have the same evidenced purpose and overlap.",
    citationIds: [`citation-${repositoryId}`]
  };
}

describe("portfolio reconciliation", () => {
  test("uses the approved 35/25/20/20 confidence formula", () => {
    expect(RECOMMENDATION_CONFIDENCE_WEIGHTS).toEqual({
      coverage: 0.35,
      citations: 0.25,
      classifierAgreement: 0.2,
      ruleSupport: 0.2
    });
    expect(
      calculateConfidence({
        coverage: 1,
        citations: 0.5,
        classifierAgreement: 0.5,
        ruleSupport: 1
      }).weightedConfidence
    ).toBeCloseTo(0.775, 12);
  });

  test("normalizes capabilities and computes deterministic Jaccard overlap", () => {
    const overlap = compareProfiles(
      profile("repo-alpha", { capabilities: ["Evidence", "Policy", "Search"] }),
      profile("repo-beta", { capabilities: ["evidence", "policy", "chat"] })
    );
    expect(overlap.sharedCapabilities).toEqual(["evidence", "policy"]);
    expect(overlap.jaccard).toBe(0.5);
  });

  test("permits combine only for same-purpose overlap at or above 0.60", () => {
    const alpha = profile("repo-alpha", {
      capabilities: ["evidence", "policy", "search", "chat"]
    });
    const beta = profile("repo-beta", {
      capabilities: ["evidence", "policy", "search", "runtime"]
    });
    expect(eligibleRecommendationActions(alpha, [beta])).toContain(
      "combine-with-peer"
    );
  });

  test("permits shared-component extraction for different purposes and bounded overlap", () => {
    const alpha = profile("repo-alpha", {
      purpose: "knowledge management",
      capabilities: ["evidence", "search", "knowledge", "chat"]
    });
    const beta = profile("repo-beta", {
      purpose: "delivery automation",
      capabilities: ["evidence", "search", "deployment", "policy"]
    });
    expect(eligibleRecommendationActions(alpha, [beta])).toContain(
      "extract-shared-component"
    );
  });

  test("defers incomplete or contradictory evidence", () => {
    expect(
      eligibleRecommendationActions(
        profile("repo-alpha", { evidenceFamilies: familyStates("work-items") }),
        []
      )
    ).toEqual(["defer-insufficient-evidence"]);
    expect(
      eligibleRecommendationActions(
        profile("repo-alpha", { contradictions: ["README conflicts with code"] }),
        []
      )
    ).toEqual(["defer-insufficient-evidence"]);
  });

  test("requires two agreeing classifier passes", () => {
    const first = proposal("repo-alpha", "keep-standalone");
    expect(classifierAgreement(first, { ...first })).toBe(1);
    expect(
      classifierAgreement(first, { ...first, action: "archive-candidate" })
    ).toBe(0.5);
    expect(
      classifierAgreement(first, { ...first, purpose: "unrelated" })
    ).toBe(0);
  });

  test("auto-finalizes only at the exact evidence, citation, rule, and agreement gate", () => {
    const subject = profile("repo-alpha", {
      capabilities: ["unique-interface"],
      isOrchestrator: true
    });
    const agreed = proposal("repo-alpha", "keep-standalone");
    const result = evaluateRecommendation({
      profile: subject,
      peers: [],
      classifier: { first: agreed, second: { ...agreed }, warnings: [] }
    });
    expect(result.confidence.weightedConfidence).toBe(1);
    expect(result.autoFinalizationEligible).toBe(true);
    expect(result.lifecycle).toBe("auto-finalized");
  });

  test("does not auto-finalize disagreement or an invalid citation", () => {
    const subject = profile("repo-alpha", {
      capabilities: ["unique-interface"],
      isOrchestrator: true
    });
    const first = proposal("repo-alpha", "keep-standalone");
    const disagreed = evaluateRecommendation({
      profile: subject,
      peers: [],
      classifier: {
        first,
        second: { ...first, action: "archive-candidate" },
        warnings: []
      }
    });
    expect(disagreed.autoFinalizationEligible).toBe(false);
    expect(disagreed.lifecycle).toBe("draft");

    const invalidCitation = evaluateRecommendation({
      profile: subject,
      peers: [],
      classifier: {
        first: { ...first, citationIds: ["citation-not-stored"] },
        second: { ...first, citationIds: ["citation-not-stored"] },
        warnings: []
      }
    });
    expect(invalidCitation.confidence.citations).toBe(0);
    expect(invalidCitation.autoFinalizationEligible).toBe(false);
  });

  test("marks an inactive fully superseded repository as an archive candidate", () => {
    const legacy = profile("repo-legacy", {
      capabilities: ["search", "chat"],
      openWorkItemCount: 0,
      lastCommitAt: "2025-01-01T00:00:00.000Z",
      supersededByRepositoryId: "repo-current"
    });
    const current = profile("repo-current", {
      capabilities: ["search", "chat", "evidence"],
      lastCommitAt: "2026-08-01T00:00:00.000Z"
    });
    expect(
      eligibleRecommendationActions(
        legacy,
        [current],
        new Date("2026-08-28T00:00:00.000Z")
      )
    ).toContain("archive-candidate");
  });
});
