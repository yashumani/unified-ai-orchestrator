import {
  canonicalJson,
  LocalEvidenceStore,
  sha256Hex
} from "@unified-ai/evidence-index";
import type {
  PortfolioIngestionResult,
  RepositoryInventoryItem,
  RepositoryPortfolioSnapshot
} from "@unified-ai/portfolio-ingestion";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  PortfolioService,
  type PortfolioClassifier,
  type PortfolioEvidencePort
} from "./index.js";

const CAPTURED_AT = "2026-08-29T00:00:00.000Z";

function inventory(
  id: number,
  fullName: string
): RepositoryInventoryItem {
  const [owner = "fixture-owner", name = "repository"] = fullName.split("/");
  return {
    id,
    owner,
    name,
    fullName,
    visibility: "public",
    defaultBranch: "main",
    archived: false,
    fork: false,
    updatedAt: CAPTURED_AT
  };
}

function snapshot(item: RepositoryInventoryItem): RepositoryPortfolioSnapshot {
  return {
    requestedFullName: item.fullName,
    fullName: item.fullName,
    status: "complete",
    attempts: 1,
    visibility: item.visibility,
    defaultBranch: item.defaultBranch,
    beforeRef: {
      branch: "main",
      commitSha: `${item.id}`.padStart(40, "a").slice(-40),
      treeSha: `${item.id}`.padStart(40, "b").slice(-40),
      observedAt: CAPTURED_AT
    },
    afterRef: {
      branch: "main",
      commitSha: `${item.id}`.padStart(40, "a").slice(-40),
      treeSha: `${item.id}`.padStart(40, "b").slice(-40),
      observedAt: CAPTURED_AT
    },
    files: [
      {
        path: "README.md",
        kind: "readme",
        sha: "c".repeat(40),
        size: 80,
        content: "# Fixture\nA unique synthetic visualization repository.",
        encoding: "utf-8",
        complete: true
      }
    ],
    releases: [],
    languages: { TypeScript: 100 },
    topics: ["visualization"],
    recentCommits: [
      {
        sha: `${item.id}`.padStart(40, "a").slice(-40),
        message: "Synthetic commit",
        authoredAt: CAPTURED_AT,
        committedAt: CAPTURED_AT,
        authorLogin: "fixture-user"
      }
    ],
    openIssues: [],
    openPullRequests: [],
    recentlyClosedWorkItems: [],
    gaps: []
  };
}

function ingestion(owner = "fixture-owner"): PortfolioIngestionResult {
  const orchestrator = inventory(1, `${owner}/unified-ai-orchestrator`);
  const source = inventory(2, `${owner}/visualizer`);
  return {
    startedAt: CAPTURED_AT,
    completedAt: CAPTURED_AT,
    inventory: [orchestrator, source],
    inventoryComplete: true,
    repositories: [snapshot(orchestrator), snapshot(source)],
    gaps: [],
    warnings: [],
    checkpoint: {
      schemaVersion: "portfolio-ingestion-checkpoint/v1",
      inventory: [orchestrator, source],
      inventoryComplete: true,
      inventoryGaps: [],
      nextRepositoryIndex: 2,
      repositories: [snapshot(orchestrator), snapshot(source)]
    }
  };
}

function memoryEvidence(): PortfolioEvidencePort & {
  objects: Map<string, unknown>;
  runs: unknown[];
  events: unknown[];
} {
  const objects = new Map<string, unknown>();
  const runs: unknown[] = [];
  const checkpoints: unknown[] = [];
  const events: unknown[] = [];
  const putObject = vi.fn(async (value: unknown) => {
    const sha256 = sha256Hex(canonicalJson(value));
    objects.set(sha256, value);
    return { sha256, relativePath: `objects/${sha256}.json` };
  });
  return {
    objects,
    runs,
    events,
    putObject,
    readObject: vi.fn(async (sha256: string) => objects.get(sha256)),
    putPortfolioRun: vi.fn(async (run) => {
      runs.push(run);
      return await putObject(run);
    }),
    listPortfolioRuns: vi.fn(async () => runs as never[]),
    putPortfolioRunCheckpoint: vi.fn(async (checkpoint) => {
      checkpoints.push(checkpoint);
      return await putObject(checkpoint);
    }),
    listPortfolioRunCheckpoints: vi.fn(async () => checkpoints as never[]),
    putRecommendationDecisionEvent: vi.fn(async (event) => {
      events.push(event);
      return await putObject(event);
    }),
    listRecommendationDecisionEvents: vi.fn(async () => events as never[])
  };
}

const agreeingClassifier: PortfolioClassifier = {
  classify: vi.fn(async (profile, eligibleActions) => {
    const action = eligibleActions[0] ?? "defer-insufficient-evidence";
    const proposal = {
      purpose: profile.purpose,
      action,
      rationale: "The cited deterministic profile supports this action.",
      citationIds: [profile.citations[0]?.citationId ?? "citation-missing"]
    };
    return { first: proposal, second: { ...proposal }, warnings: [] };
  })
};

describe("PortfolioService", () => {
  test("persists a cited source-only analysis and proves unchanged refs", async () => {
    const evidence = memoryEvidence();
    const service = new PortfolioService({
      owner: "fixture-owner",
      orchestratorFullName: "fixture-owner/unified-ai-orchestrator",
      ingestor: { ingestOwnedPortfolio: vi.fn(async () => ingestion()) },
      evidence,
      classifier: agreeingClassifier,
      now: () => new Date(CAPTURED_AT),
      runId: () => "portfolio-run-fixture-one"
    });

    expect(service.startRun().status).toBe("queued");
    const completed = await service.waitForRun("portfolio-run-fixture-one");

    expect(completed).toMatchObject({
      status: "succeeded",
      repositoryCount: 1,
      completeCount: 1,
      incompleteCount: 0,
      revisionMismatchCount: 0
    });
    expect(evidence.runs).toHaveLength(1);
    expect(service.listRepositories()).toHaveLength(1);
    expect(service.listRepositories()[0]?.fullName).toBe(
      "fixture-owner/visualizer"
    );
    expect(JSON.stringify(service.listRepositories())).not.toContain(
      "unified-ai-orchestrator"
    );
    expect(service.listRecommendations()).toHaveLength(1);
    expect(service.listRecommendations()[0]?.lifecycle).toBe("auto-finalized");
    expect(evidence.events).toHaveLength(1);
  });

  test("fails closed when the authoritative inventory owner does not match", async () => {
    const evidence = memoryEvidence();
    const service = new PortfolioService({
      owner: "fixture-owner",
      orchestratorFullName: "fixture-owner/unified-ai-orchestrator",
      ingestor: {
        ingestOwnedPortfolio: vi.fn(async () => ingestion("unexpected-owner"))
      },
      evidence,
      now: () => new Date(CAPTURED_AT),
      runId: () => "portfolio-run-owner-mismatch"
    });

    service.startRun();
    const result = await service.waitForRun("portfolio-run-owner-mismatch");

    expect(result.status).toBe("failed");
    expect(result.warnings[0]).toContain("owner does not match");
    expect(evidence.runs).toHaveLength(0);
  });

  test("appends a receipt-backed user override without external action", async () => {
    const evidence = memoryEvidence();
    const service = new PortfolioService({
      owner: "fixture-owner",
      orchestratorFullName: "fixture-owner/unified-ai-orchestrator",
      ingestor: { ingestOwnedPortfolio: vi.fn(async () => ingestion()) },
      evidence,
      classifier: agreeingClassifier,
      now: () => new Date(CAPTURED_AT),
      runId: () => "portfolio-run-fixture-override"
    });
    service.startRun();
    await service.waitForRun("portfolio-run-fixture-override");
    const recommendation = service.listRecommendations()[0];
    if (recommendation === undefined) {
      throw new Error("fixture recommendation missing");
    }

    const overridden = await service.overrideRecommendation({
      recommendationId: recommendation.recommendationId,
      action: "keep-standalone",
      reasonCode: "strategic-priority",
      explanation: "Keep this synthetic repository independently visible.",
      providedBy: "operator-yashu"
    });

    expect(overridden.lifecycle).toBe("overridden");
    expect(overridden.action).toBe("keep-standalone");
    expect(overridden.decisionHistory).toHaveLength(2);
    expect(evidence.events).toHaveLength(2);
  });

  test("recovers only schema- and hash-bound sanitized aggregates", async () => {
    const evidence = memoryEvidence();
    const first = new PortfolioService({
      owner: "fixture-owner",
      orchestratorFullName: "fixture-owner/unified-ai-orchestrator",
      ingestor: { ingestOwnedPortfolio: vi.fn(async () => ingestion()) },
      evidence,
      classifier: agreeingClassifier,
      now: () => new Date(CAPTURED_AT),
      runId: () => "portfolio-run-recovery"
    });
    first.startRun();
    await first.waitForRun("portfolio-run-recovery");

    const recovered = new PortfolioService({
      owner: "fixture-owner",
      orchestratorFullName: "fixture-owner/unified-ai-orchestrator",
      ingestor: { ingestOwnedPortfolio: vi.fn(async () => ingestion()) },
      evidence,
      now: () => new Date(CAPTURED_AT)
    });
    await recovered.initialize();

    expect(recovered.listRuns()).toHaveLength(1);
    expect(recovered.listRepositories()).toHaveLength(1);
    expect(recovered.listRecommendations()[0]?.decisionHistory).toHaveLength(1);
  });

  test("recovers the newest override and advances its sequence after more than 100 events", async () => {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), "uao-portfolio-decision-recovery-")
    );
    const repositoryRoot = join(temporaryRoot, "repository");
    await mkdir(repositoryRoot, { recursive: true });
    const evidence = new LocalEvidenceStore({
      root: join(repositoryRoot, ".local", "evidence"),
      repositoryRoot
    });
    let clock = 0;
    const now = (): Date =>
      new Date(Date.parse(CAPTURED_AT) + clock++ * 1_000);

    try {
      const first = new PortfolioService({
        owner: "fixture-owner",
        orchestratorFullName: "fixture-owner/unified-ai-orchestrator",
        ingestor: { ingestOwnedPortfolio: vi.fn(async () => ingestion()) },
        evidence,
        classifier: agreeingClassifier,
        now,
        runId: () => "portfolio-run-bounded-decision-recovery"
      });
      first.startRun();
      await first.waitForRun("portfolio-run-bounded-decision-recovery");
      const recommendationId =
        first.listRecommendations()[0]?.recommendationId;
      if (recommendationId === undefined) {
        throw new Error("fixture recommendation missing");
      }

      for (let sequence = 1; sequence <= 101; sequence += 1) {
        await first.overrideRecommendation({
          recommendationId,
          action:
            sequence % 2 === 1 ? "archive-candidate" : "keep-standalone",
          reasonCode: "strategic-priority",
          explanation: `Synthetic bounded recovery override ${String(sequence)}.`,
          providedBy: "operator-yashu"
        });
      }

      const recovered = new PortfolioService({
        owner: "fixture-owner",
        orchestratorFullName: "fixture-owner/unified-ai-orchestrator",
        ingestor: { ingestOwnedPortfolio: vi.fn(async () => ingestion()) },
        evidence,
        now
      });
      await recovered.initialize();

      const latest = recovered.listRecommendations()[0];
      expect(latest).toMatchObject({
        recommendationId,
        action: "archive-candidate",
        lifecycle: "overridden"
      });
      expect(latest?.decisionHistory).toHaveLength(100);
      expect(latest?.decisionHistory[0]?.sequence).toBe(2);
      expect(latest?.decisionHistory.at(-1)?.sequence).toBe(101);

      const next = await recovered.overrideRecommendation({
        recommendationId,
        action: "keep-standalone",
        reasonCode: "strategic-priority",
        explanation: "Prove recovery allocates the next unused sequence.",
        providedBy: "operator-yashu"
      });
      expect(next.decisionHistory.at(-1)).toMatchObject({
        eventId: `decision-${recommendationId}-102`,
        sequence: 102,
        action: "keep-standalone"
      });
      await expect(
        evidence.readRecommendationDecisionEvent(
          `decision-${recommendationId}-102`
        )
      ).resolves.toMatchObject({ sequence: 102 });
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("treats imported chat as non-authoritative intent on the next run", async () => {
    const evidence = memoryEvidence();
    const runIds = ["portfolio-run-chat-before", "portfolio-run-chat-after"];
    const service = new PortfolioService({
      owner: "fixture-owner",
      orchestratorFullName: "fixture-owner/unified-ai-orchestrator",
      ingestor: { ingestOwnedPortfolio: vi.fn(async () => ingestion()) },
      evidence,
      classifier: agreeingClassifier,
      chatImporter: {
        import: vi.fn(async () => ({
          snapshots: [
            {
              conversationId: "conversation-fixture",
              title: "Visualizer implementation",
              turns: [{ content: "The visualizer was not deployed." }]
            }
          ],
          ingestions: [{ receipt: { receiptId: "receipt-chat-fixture" } }]
        }))
      },
      now: () => new Date(CAPTURED_AT),
      runId: () => runIds.shift() ?? "portfolio-run-extra"
    });
    service.startRun();
    await service.waitForRun("portfolio-run-chat-before");

    await expect(
      service.importChat([], "app-development")
    ).resolves.toMatchObject({ importedCount: 1, receiptId: "receipt-chat-fixture" });
    service.startRun();
    await service.waitForRun("portfolio-run-chat-after");

    expect(service.listRepositories()[0]?.chatCoverage).toBe(1);
    expect(service.listRepositories()[0]?.contradictions).toHaveLength(1);
    expect(service.listRecommendations()[0]?.action).toBe(
      "defer-insufficient-evidence"
    );
    expect(service.listRecommendations()[0]?.lifecycle).toBe("deferred");
  });
});
