import { describe, expect, it } from "vitest";
import {
  AgentRunReceiptSchema,
  AgentUsageSchema,
  ClaimRecordSchema,
  ConversationSnapshotSchema,
  EvidenceFamilySchema,
  EvidenceEnvelopeSchema,
  OverlapClusterSchema,
  PINNED_OLLAMA_MODEL,
  PolicyDecisionSchema,
  PortfolioRecommendationSchema,
  PortfolioRunCheckpointSchema,
  PortfolioRunSchema,
  RecommendationActionSchema,
  RecommendationConfidenceSchema,
  RecommendationDecisionEventSchema,
  RecommendationLifecycleSchema,
  RepositoryCitationSchema,
  RepositoryProfileSchema,
  RepositorySnapshotSchema,
  RepositoryToolNameSchema,
  SCHEMA_VERSION,
  SourceReferenceSchema
} from "./index.js";

const sha = "a".repeat(64);
const revision = "b".repeat(40);
const capturedAt = "2026-08-28T20:00:00.000Z";
const repositoryBinding = {
  repositoryId: "repository-alpha",
  capturedRevision: revision,
  capturedAt,
  evidenceObjectSha256: sha
} as const;
const source = {
  schemaVersion: SCHEMA_VERSION,
  sourceId: "conversation-001",
  sourceType: "chatgpt-conversation",
  capturedAt: "2026-08-27T20:00:00.000Z",
  contentSha256: sha,
  locator: {
    conversationId: "conversation-001",
    turnId: "turn-001"
  }
} as const;

describe("provenance contracts", () => {
  it("accepts a valid source reference", () => {
    expect(SourceReferenceSchema.parse(source)).toEqual(source);
  });

  it("rejects non-lowercase or incomplete hashes", () => {
    expect(() =>
      SourceReferenceSchema.parse({
        ...source,
        contentSha256: "A".repeat(64)
      })
    ).toThrow();

    expect(() =>
      SourceReferenceSchema.parse({
        ...source,
        contentSha256: "a".repeat(63)
      })
    ).toThrow();
  });

  it("requires UTC timestamps", () => {
    expect(() =>
      SourceReferenceSchema.parse({
        ...source,
        capturedAt: "2026-08-27T16:00:00.000-04:00"
      })
    ).toThrow();
  });

  it("defaults conversation-derived claims to unverified", () => {
    const claim = ClaimRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      claimId: "claim-001",
      claimType: "implementation",
      assertedBy: "assistant",
      statement: "The feature is deployed.",
      source,
      evidenceObjectSha256: sha
    });

    expect(claim.status).toBe("unverified");
  });

  it("rejects duplicate conversation turn identifiers", () => {
    const turn = {
      schemaVersion: SCHEMA_VERSION,
      turnId: "turn-001",
      actor: "user",
      occurredAt: "2026-08-27T20:00:00.000Z",
      content: "Build one orchestrator."
    } as const;

    expect(() =>
      ConversationSnapshotSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        sourceSystem: "chatgpt",
        projectId: "app-development",
        conversationId: "conversation-001",
        title: "Synthetic Unified Pilot",
        createdAt: "2026-08-27T20:00:00.000Z",
        updatedAt: "2026-08-27T20:01:00.000Z",
        turns: [turn, turn]
      })
    ).toThrow();
  });

  it("rejects unknown evidence-envelope fields", () => {
    expect(() =>
      EvidenceEnvelopeSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        evidenceId: "evidence-001",
        capturedAt: "2026-08-27T20:00:00.000Z",
        mediaType: "application/json",
        source,
        payload: {},
        secret: "must-not-pass"
      })
    ).toThrow();
  });
});

describe("orchestration contracts", () => {
  it("pins the Phase 1 Ollama model", () => {
    expect(PINNED_OLLAMA_MODEL).toBe("qwen3:4b");
  });

  it("rejects a policy decision whose boolean and code disagree", () => {
    expect(() =>
      PolicyDecisionSchema.parse({
        allowed: true,
        code: "protected_branch",
        reason: "main is protected",
        checkedAt: "2026-08-28T05:00:00.000Z"
      })
    ).toThrow();
  });

  it("rejects receipts beyond the fixed iteration limit", () => {
    expect(() =>
      AgentRunReceiptSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        runId: "run-001",
        threadId: "thread-001",
        messageIds: ["message-001"],
        status: "succeeded",
        model: PINNED_OLLAMA_MODEL,
        runtime: { contextSize: 4096, temperature: 0.2, thinking: false },
        toolSchemaObjectSha256: sha,
        workspace: {
          repositoryRootSha256: sha,
          originSha256: sha,
          branch: "feature/test"
        },
        startedAt: "2026-08-28T05:00:00.000Z",
        completedAt: "2026-08-28T05:01:00.000Z",
        iterations: 9,
        toolCalls: [],
        inputObjectSha256: sha
      })
    ).toThrow();
  });

  it("records whether Ollama usage counters were available", () => {
    expect(AgentUsageSchema.parse({ available: false })).toEqual({
      available: false
    });
    expect(
      AgentUsageSchema.parse({ available: true, evalCount: 12 })
    ).toEqual({ available: true, evalCount: 12 });
    expect(() =>
      AgentUsageSchema.parse({ available: false, evalCount: 12 })
    ).toThrow();
  });
});

describe("portfolio rationalization contracts", () => {
  const evidenceFamilies = [
    "identity",
    "default-branch",
    "documentation",
    "manifests",
    "workflows",
    "releases",
    "commits",
    "work-items"
  ] as const;
  const evidence = evidenceFamilies.map((family) => ({
    schemaVersion: SCHEMA_VERSION,
    evidenceId: `evidence-${family}`,
    family,
    ...repositoryBinding,
    summary: `Synthetic ${family} evidence.`
  }));

  it("defines exactly the eight required evidence families", () => {
    expect(EvidenceFamilySchema.options).toEqual(evidenceFamilies);
  });

  it("requires a repository snapshot to bind every evidence family to one revision", () => {
    const snapshot = RepositorySnapshotSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      snapshotId: "snapshot-alpha",
      ...repositoryBinding,
      evidence
    });

    expect(snapshot.evidence).toHaveLength(8);
    expect(() =>
      RepositorySnapshotSchema.parse({
        ...snapshot,
        evidence: snapshot.evidence.slice(0, 7)
      })
    ).toThrow(/evidence famil/u);
    expect(() =>
      RepositorySnapshotSchema.parse({
        ...snapshot,
        evidence: [
          ...snapshot.evidence.slice(0, 7),
          { ...snapshot.evidence[7], capturedRevision: "c".repeat(40) }
        ]
      })
    ).toThrow(/snapshot repository and revision/u);
  });

  it("strictly validates repository profiles and citations at a captured revision", () => {
    const citation = RepositoryCitationSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      citationId: "citation-alpha",
      family: "documentation",
      ...repositoryBinding,
      locator: "README.md#purpose",
      statement: "The repository provides a synthetic portfolio capability."
    });
    const profile = RepositoryProfileSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      profileId: "profile-alpha",
      snapshotId: "snapshot-alpha",
      ...repositoryBinding,
      name: "Repository Alpha",
      summary: "Synthetic profile for contract validation.",
      purposes: ["portfolio analysis"],
      capabilities: ["repository inventory"],
      technologyTags: ["typescript"],
      citationIds: [citation.citationId]
    });

    expect(profile.repositoryId).toBe(citation.repositoryId);
    expect(() =>
      RepositoryProfileSchema.parse({ ...profile, untrustedField: true })
    ).toThrow();
    expect(() =>
      RepositoryCitationSchema.parse({
        ...citation,
        capturedAt: "2026-08-28T16:00:00.000-04:00"
      })
    ).toThrow();
  });

  it("represents immutable run checkpoints and bound errors instead of mutable current state", () => {
    const run = PortfolioRunSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      runId: "portfolio-run-alpha",
      createdAt: capturedAt,
      evidenceObjectSha256: sha,
      repositories: [repositoryBinding]
    });
    const checkpoint = PortfolioRunCheckpointSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      checkpointId: "checkpoint-alpha",
      runId: run.runId,
      sequence: 1,
      status: "failed",
      occurredAt: capturedAt,
      evidenceObjectSha256: sha,
      repositories: [repositoryBinding],
      errors: [
        {
          schemaVersion: SCHEMA_VERSION,
          errorId: "portfolio-error-alpha",
          runId: run.runId,
          code: "repository-unavailable",
          message: "Synthetic repository evidence was unavailable.",
          retryable: true,
          occurredAt: capturedAt,
          evidenceObjectSha256: sha,
          repository: repositoryBinding
        }
      ]
    });

    expect(checkpoint.errors[0]?.repository?.repositoryId).toBe(
      repositoryBinding.repositoryId
    );
    expect(() =>
      PortfolioRunCheckpointSchema.parse({
        ...checkpoint,
        errors: [{ ...checkpoint.errors[0], runId: "portfolio-run-other" }]
      })
    ).toThrow(/checkpoint run/u);
  });

  it("pins recommendation actions and validates deterministic confidence", () => {
    expect(RecommendationActionSchema.options).toEqual([
      "keep-standalone",
      "combine-with-peer",
      "extract-shared-component",
      "adopt-capability-into-orchestrator",
      "archive-candidate",
      "defer-insufficient-evidence"
    ]);
    expect(RecommendationLifecycleSchema.options).toEqual([
      "draft",
      "auto-finalized",
      "overridden",
      "deferred"
    ]);
    expect(
      RecommendationConfidenceSchema.parse({
        coverage: 1,
        citations: 0.8,
        classifierAgreement: 0.5,
        ruleSupport: 0.6,
        weightedConfidence: 0.77
      }).weightedConfidence
    ).toBe(0.77);
    expect(() =>
      RecommendationConfidenceSchema.parse({
        coverage: 1.1,
        citations: 0.8,
        classifierAgreement: 0.5,
        ruleSupport: 0.6,
        weightedConfidence: 0.77
      })
    ).toThrow();
    expect(() =>
      RecommendationConfidenceSchema.parse({
        coverage: 1,
        citations: 0.8,
        classifierAgreement: 0.5,
        ruleSupport: 0.6,
        weightedConfidence: 0.5
      })
    ).toThrow(/weightedConfidence/u);
  });

  it("pins only read-only portfolio model tool names", () => {
    for (const name of [
      "portfolio.list_repositories",
      "portfolio.get_repository",
      "portfolio.list_clusters",
      "portfolio.explain_overlap",
      "portfolio.list_recommendations",
      "portfolio.resolve_citation"
    ]) {
      expect(RepositoryToolNameSchema.parse(name)).toBe(name);
    }
    expect(() => RepositoryToolNameSchema.parse("portfolio.refresh")).toThrow();
    expect(() => RepositoryToolNameSchema.parse("portfolio.override")).toThrow();
  });

  it("binds overlap clusters and recommendations to repository evidence", () => {
    const secondBinding = {
      repositoryId: "repository-beta",
      capturedRevision: "c".repeat(40),
      capturedAt,
      evidenceObjectSha256: "d".repeat(64)
    } as const;
    const cluster = OverlapClusterSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      clusterId: "cluster-alpha-beta",
      createdAt: capturedAt,
      evidenceObjectSha256: sha,
      label: "Synthetic overlap",
      rationale: "Both repositories expose the same synthetic capability.",
      sharedCapabilities: ["repository inventory"],
      repositories: [repositoryBinding, secondBinding],
      citationIds: ["citation-alpha", "citation-beta"]
    });
    const recommendation = PortfolioRecommendationSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      recommendationId: "recommendation-alpha-beta",
      runId: "portfolio-run-alpha",
      clusterId: cluster.clusterId,
      action: "combine-with-peer",
      lifecycle: "auto-finalized",
      createdAt: capturedAt,
      evidenceObjectSha256: sha,
      repositories: cluster.repositories,
      citationIds: cluster.citationIds,
      rationale: "Combine the duplicate synthetic capability.",
      confidence: {
        coverage: 1,
        citations: 1,
        classifierAgreement: 1,
        ruleSupport: 1,
        weightedConfidence: 1
      }
    });

    expect(recommendation.repositories).toHaveLength(2);
    expect(() =>
      PortfolioRecommendationSchema.parse({
        ...recommendation,
        repositories: [repositoryBinding]
      })
    ).toThrow(/combine-with-peer/u);
    expect(() =>
      PortfolioRecommendationSchema.parse({
        ...recommendation,
        confidence: {
          coverage: 1,
          citations: 0.8,
          classifierAgreement: 0.5,
          ruleSupport: 0.6,
          weightedConfidence: 0.77
        }
      })
    ).toThrow(/exact confidence gate/u);
    expect(() =>
      PortfolioRecommendationSchema.parse({
        ...recommendation,
        confidence: {
          coverage: 1,
          citations: 1,
          classifierAgreement: 0.5,
          ruleSupport: 1,
          weightedConfidence: 0.9
        }
      })
    ).toThrow(/exact confidence gate/u);
  });

  it("requires an explicit user reason for an override decision event", () => {
    const event = RecommendationDecisionEventSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: "decision-event-alpha",
      recommendationId: "recommendation-alpha-beta",
      runId: "portfolio-run-alpha",
      sequence: 2,
      actor: "user",
      previousLifecycle: "auto-finalized",
      previousAction: "combine-with-peer",
      lifecycle: "overridden",
      action: "keep-standalone",
      occurredAt: capturedAt,
      recommendationObjectSha256: "e".repeat(64),
      evidenceObjectSha256: sha,
      receiptObjectSha256: "f".repeat(64),
      repositories: [repositoryBinding],
      reason: "A user supplied strategic context unavailable to the classifier.",
      override: {
        reasonCode: "strategic-priority",
        explanation: "The repository must remain independently deployable.",
        providedBy: "user-yashu",
        providedAt: capturedAt
      }
    });

    expect(event.override?.reasonCode).toBe("strategic-priority");
    expect(() =>
      RecommendationDecisionEventSchema.parse({ ...event, override: undefined })
    ).toThrow(/override reason/u);
    expect(() =>
      RecommendationDecisionEventSchema.parse({
        ...event,
        actor: "system"
      })
    ).toThrow(/user actor/u);
  });
});
