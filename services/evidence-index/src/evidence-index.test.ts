import {
  AgentRunReceiptSchema,
  EvidenceReceiptSchema,
  PINNED_OLLAMA_MODEL,
  PortfolioRunCheckpointSchema,
  PortfolioRunSchema,
  RecommendationDecisionEventSchema,
  SCHEMA_VERSION,
  type AgentRunReceipt,
  type EvidenceReceipt,
  type PortfolioRun,
  type PortfolioRunCheckpoint,
  type RecommendationDecisionEvent
} from "@unified-ai/contracts";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "./canonical-json.js";
import {
  LocalEvidenceStore,
  resolveWithinRoot
} from "./local-evidence-store.js";

const temporaryRoots: string[] = [];

async function makeStore(): Promise<{
  root: string;
  repositoryRoot: string;
  store: LocalEvidenceStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "uao-evidence-test-"));
  temporaryRoots.push(root);

  const repositoryRoot = join(root, "repository");
  const evidenceRoot = join(repositoryRoot, ".local", "evidence");
  await mkdir(repositoryRoot, { recursive: true });

  return {
    root,
    repositoryRoot,
    store: new LocalEvidenceStore({
      root: evidenceRoot,
      repositoryRoot
    })
  };
}

function makeAgentRunReceipt(
  runId: string,
  completedAt: string,
  overrides: Partial<AgentRunReceipt> = {}
): AgentRunReceipt {
  return AgentRunReceiptSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    runId,
    threadId: "thread-evidence",
    messageIds: ["message-evidence"],
    status: "succeeded",
    model: PINNED_OLLAMA_MODEL,
    runtime: { contextSize: 4096, temperature: 0.2, thinking: false },
    toolSchemaObjectSha256: "c".repeat(64),
    workspace: {
      repositoryRootSha256: "d".repeat(64),
      originSha256: "e".repeat(64),
      branch: "feature/evidence"
    },
    startedAt: completedAt,
    completedAt,
    iterations: 1,
    toolCalls: [],
    inputObjectSha256: "a".repeat(64),
    outputObjectSha256: "b".repeat(64),
    warnings: [],
    ...overrides
  });
}

const portfolioCapturedAt = "2026-08-28T20:00:00.000Z";
const portfolioRepository = {
  repositoryId: "repository-alpha",
  capturedRevision: "b".repeat(40),
  capturedAt: portfolioCapturedAt,
  evidenceObjectSha256: "a".repeat(64)
} as const;

function makePortfolioRun(
  runId: string,
  overrides: Partial<PortfolioRun> = {}
): PortfolioRun {
  return PortfolioRunSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    runId,
    createdAt: portfolioCapturedAt,
    evidenceObjectSha256: "c".repeat(64),
    repositories: [portfolioRepository],
    ...overrides
  });
}

function makePortfolioCheckpoint(
  checkpointId: string,
  sequence: number,
  overrides: Partial<PortfolioRunCheckpoint> = {}
): PortfolioRunCheckpoint {
  return PortfolioRunCheckpointSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    checkpointId,
    runId: "portfolio-run-alpha",
    sequence,
    status: "running",
    occurredAt: portfolioCapturedAt,
    evidenceObjectSha256: "d".repeat(64),
    repositories: [portfolioRepository],
    errors: [],
    ...overrides
  });
}

function makeRecommendationDecisionEvent(
  eventId: string,
  sequence: number,
  overrides: Partial<RecommendationDecisionEvent> = {}
): RecommendationDecisionEvent {
  return RecommendationDecisionEventSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    eventId,
    recommendationId: "recommendation-alpha",
    runId: "portfolio-run-alpha",
    sequence,
    actor: "system",
    lifecycle: "draft",
    action: "keep-standalone",
    occurredAt: portfolioCapturedAt,
    recommendationObjectSha256: "e".repeat(64),
    evidenceObjectSha256: "f".repeat(64),
    receiptObjectSha256: "1".repeat(64),
    repositories: [portfolioRepository],
    reason: "Synthetic deterministic recommendation event.",
    ...overrides
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("canonical JSON", () => {
  it("sorts object keys and produces deterministic hashes", () => {
    const first = canonicalJson({ z: 1, a: { y: true, b: "value" } });
    const second = canonicalJson({ a: { b: "value", y: true }, z: 1 });

    expect(first).toBe('{"a":{"b":"value","y":true},"z":1}');
    expect(second).toBe(first);
    expect(sha256Hex(first)).toBe(sha256Hex(second));
  });

  it("rejects cycles and unsupported values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/u);
    expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/u);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/u);
  });
});

describe("local evidence store", () => {
  it("rejects traversal outside its root", () => {
    expect(() => resolveWithinRoot("C:\\safe-root", "..", "escape.json")).toThrow(
      /escapes/u
    );
  });

  it("requires the evidence root to be a lexical repository descendant", async () => {
    const root = await mkdtemp(join(tmpdir(), "uao-root-test-"));
    temporaryRoots.push(root);
    const repositoryRoot = join(root, "repository");
    await mkdir(repositoryRoot);

    expect(
      () =>
        new LocalEvidenceStore({
          root: repositoryRoot,
          repositoryRoot
        })
    ).toThrow(/repository root/u);

    expect(
      () =>
        new LocalEvidenceStore({
          root,
          repositoryRoot
        })
    ).toThrow(/lexical descendant/u);

    expect(
      () =>
        new LocalEvidenceStore({
          root: join(root, "outside"),
          repositoryRoot
        })
    ).toThrow(/lexical descendant/u);
  });

  it("rejects an evidence root component that is an outside junction", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "uao-junction-test-"));
    temporaryRoots.push(root);
    const repositoryRoot = join(root, "repository");
    const outsideRoot = join(root, "outside");
    await mkdir(repositoryRoot);
    await mkdir(outsideRoot);

    try {
      await symlink(
        outsideRoot,
        join(repositoryRoot, ".local"),
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch (error) {
      if (
        ["EPERM", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? ""
        )
      ) {
        context.skip();
        return;
      }
      throw error;
    }

    const store = new LocalEvidenceStore({
      root: join(repositoryRoot, ".local", "evidence"),
      repositoryRoot
    });

    await expect(store.initialize()).rejects.toThrow(/symbolic link|junction/u);
    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it("rejects a cached evidence root replaced by an outside junction", async (context) => {
    const { root, repositoryRoot, store } = await makeStore();
    const evidenceRoot = join(repositoryRoot, ".local", "evidence");
    const originalRoot = join(repositoryRoot, ".local", "evidence-original");
    const outsideRoot = join(root, "outside");
    await store.initialize();
    await mkdir(outsideRoot);
    await rename(evidenceRoot, originalRoot);

    try {
      await symlink(
        outsideRoot,
        evidenceRoot,
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch (error) {
      await rename(originalRoot, evidenceRoot);
      if (
        ["EPERM", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? ""
        )
      ) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(store.putObject({ redirected: true })).rejects.toThrow(
      /symbolic link|junction/u
    );
    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it("rejects a cached evidence root replaced by a different directory", async () => {
    const { repositoryRoot, store } = await makeStore();
    const evidenceRoot = join(repositoryRoot, ".local", "evidence");
    const originalRoot = join(repositoryRoot, ".local", "evidence-original");
    await store.initialize();
    await rename(evidenceRoot, originalRoot);
    await mkdir(evidenceRoot);

    await expect(store.putObject({ replaced: true })).rejects.toThrow(
      /changed since initialization/u
    );
  });

  it("writes identical objects idempotently and verifies integrity", async () => {
    const { repositoryRoot, store } = await makeStore();
    const value = { schemaVersion: SCHEMA_VERSION, message: "synthetic" };

    const first = await store.putObject(value);
    const second = await store.putObject({ message: "synthetic", schemaVersion: SCHEMA_VERSION });

    expect(second).toEqual(first);
    expect(await store.readObject(first.sha256)).toEqual(value);
    expect(resolve(repositoryRoot, first.relativePath)).not.toBe(repositoryRoot);
  });

  it("creates the evidence root safely under concurrent first writes", async () => {
    const { store } = await makeStore();
    const values = Array.from({ length: 16 }, (_, index) => ({
      schemaVersion: SCHEMA_VERSION,
      index
    }));

    const stored = await Promise.all(values.map((value) => store.putObject(value)));

    await Promise.all(
      stored.map(async (item, index) => {
        expect(await store.readObject(item.sha256)).toEqual(values[index]);
      })
    );
  });

  it("detects tampered evidence", async () => {
    const { repositoryRoot, store } = await makeStore();
    const stored = await store.putObject({ value: "original" });
    const evidenceRoot = join(repositoryRoot, ".local", "evidence");
    const target = join(evidenceRoot, stored.relativePath);

    await writeFile(target, '{"value":"tampered"}', "utf8");

    await expect(store.readObject(stored.sha256)).rejects.toThrow(/integrity/u);
  });

  it("stores receipts immutably", async () => {
    const { repositoryRoot, store } = await makeStore();
    const receipt: EvidenceReceipt = EvidenceReceiptSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      receiptId: "receipt-001",
      operation: "ingest-conversation",
      startedAt: "2026-08-27T20:00:00.000Z",
      completedAt: "2026-08-27T20:00:00.000Z",
      inputObjectSha256: ["a".repeat(64)],
      claimIds: ["claim-001"],
      outcome: "succeeded",
      warnings: []
    });

    const first = await store.putReceipt(receipt);
    const second = await store.putReceipt(receipt);
    expect(second).toEqual(first);

    const target = join(repositoryRoot, ".local", "evidence", first.relativePath);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(receipt);

    await expect(
      store.putReceipt({
        ...receipt,
        warnings: ["different"]
      })
    ).rejects.toThrow(/immutable/u);
  });

  it("round-trips a validated agent run receipt", async () => {
    const { repositoryRoot, store } = await makeStore();
    const receipt = makeAgentRunReceipt(
      "run-round-trip",
      "2026-08-28T01:00:00.000Z"
    );

    const stored = await store.putAgentRunReceipt(receipt);

    expect(stored.relativePath).toBe("agent-runs/run-round-trip.json");
    expect(await store.readAgentRunReceipt(receipt.runId)).toEqual(receipt);

    const target = join(repositoryRoot, ".local", "evidence", stored.relativePath);
    expect(await readFile(target, "utf8")).toBe(canonicalJson(receipt));
  });

  it("detects valid-schema tampering in an agent run receipt", async () => {
    const { repositoryRoot, store } = await makeStore();
    const receipt = makeAgentRunReceipt(
      "run-tampered",
      "2026-08-28T01:00:00.000Z"
    );
    const stored = await store.putAgentRunReceipt(receipt);
    const target = join(repositoryRoot, ".local", "evidence", stored.relativePath);

    await writeFile(
      target,
      canonicalJson({ ...receipt, warnings: ["tampered after persistence"] }),
      "utf8"
    );

    await expect(store.readAgentRunReceipt(receipt.runId)).rejects.toThrow(
      /content-addressed integrity/u
    );
  });

  it("refuses conflicting reuse of an immutable agent run id", async () => {
    const { store } = await makeStore();
    const receipt = makeAgentRunReceipt(
      "run-conflict",
      "2026-08-28T01:00:00.000Z"
    );

    const first = await store.putAgentRunReceipt(receipt);
    const second = await store.putAgentRunReceipt(receipt);
    expect(second).toEqual(first);

    await expect(
      store.putAgentRunReceipt({
        ...receipt,
        warnings: ["different immutable content"]
      })
    ).rejects.toThrow(/immutable/u);
    expect(await store.readAgentRunReceipt(receipt.runId)).toEqual(receipt);
  });

  it("rejects traversal-like agent run ids before resolving a path", async () => {
    const { store } = await makeStore();

    await expect(store.readAgentRunReceipt("../escape")).rejects.toThrow();
    await expect(
      store.putAgentRunReceipt({
        ...makeAgentRunReceipt("run-safe", "2026-08-28T01:00:00.000Z"),
        runId: "../escape"
      } as AgentRunReceipt)
    ).rejects.toThrow();
  });

  it("lists validated agent run receipts newest-first with a hard limit", async () => {
    const { repositoryRoot, store } = await makeStore();
    expect(await store.listAgentRunReceipts()).toEqual([]);

    const oldest = makeAgentRunReceipt(
      "run-oldest",
      "2026-08-28T01:00:00.000Z"
    );
    const newest = makeAgentRunReceipt(
      "run-newest",
      "2026-08-28T03:00:00.000Z"
    );
    const middle = makeAgentRunReceipt(
      "run-middle",
      "2026-08-28T02:00:00.000Z"
    );

    await store.putAgentRunReceipt(oldest);
    await store.putAgentRunReceipt(newest);
    await store.putAgentRunReceipt(middle);

    const agentRunRoot = join(
      repositoryRoot,
      ".local",
      "evidence",
      "agent-runs"
    );
    await writeFile(join(agentRunRoot, "notes.txt"), "ignore me", "utf8");
    await writeFile(join(agentRunRoot, "invalid.json"), "not-json", "utf8");
    await writeFile(
      join(agentRunRoot, "payload-bearing.json"),
      JSON.stringify({
        ...middle,
        runId: "payload-bearing",
        prompt: "must never be exposed",
        toolPayload: { privateValue: "must never be exposed" }
      }),
      "utf8"
    );

    await expect(store.listAgentRunReceipts(0)).rejects.toThrow(/limit/u);
    await expect(store.listAgentRunReceipts(101)).rejects.toThrow(/limit/u);
    await expect(store.listAgentRunReceipts(1.5)).rejects.toThrow(/limit/u);

    const receipts = await store.listAgentRunReceipts(2);
    expect(receipts).toEqual([newest, middle]);
    expect(receipts).toHaveLength(2);
    expect(receipts.every((receipt) => AgentRunReceiptSchema.safeParse(receipt).success)).toBe(
      true
    );
  });

  it("round-trips immutable portfolio runs with checksum sidecars", async () => {
    const { repositoryRoot, store } = await makeStore();
    const run = makePortfolioRun("portfolio-run-alpha");

    const first = await store.putPortfolioRun(run);
    const duplicate = await store.putPortfolioRun(run);

    expect(duplicate).toEqual(first);
    expect(first.relativePath).toBe("portfolio-runs/portfolio-run-alpha.json");
    expect(await store.readPortfolioRun(run.runId)).toEqual(run);
    expect(await store.listPortfolioRuns()).toEqual([run]);
    expect(
      await readFile(
        join(
          repositoryRoot,
          ".local",
          "evidence",
          "portfolio-runs",
          "portfolio-run-alpha.sha256"
        ),
        "utf8"
      )
    ).toBe(first.sha256);
  });

  it("atomically rejects conflicting concurrent portfolio run IDs", async () => {
    const { store } = await makeStore();
    const first = makePortfolioRun("portfolio-run-conflict");
    const second = makePortfolioRun("portfolio-run-conflict", {
      evidenceObjectSha256: "9".repeat(64)
    });

    const results = await Promise.allSettled([
      store.putPortfolioRun(first),
      store.putPortfolioRun(second)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const stored = await store.readPortfolioRun(first.runId);
    expect([first, second]).toContainEqual(stored);
  });

  it("detects checksum, canonical, and path-identity tampering in portfolio runs", async () => {
    const { repositoryRoot, store } = await makeStore();
    const run = makePortfolioRun("portfolio-run-tampered");
    const stored = await store.putPortfolioRun(run);
    const target = join(repositoryRoot, ".local", "evidence", stored.relativePath);
    const checksumTarget = target.replace(/\.json$/u, ".sha256");

    await writeFile(target, canonicalJson({ ...run, evidenceObjectSha256: "8".repeat(64) }), "utf8");
    await expect(store.readPortfolioRun(run.runId)).rejects.toThrow(/integrity/u);

    const pretty = JSON.stringify(run, null, 2);
    await writeFile(target, pretty, "utf8");
    await writeFile(checksumTarget, sha256Hex(pretty), "utf8");
    await expect(store.readPortfolioRun(run.runId)).rejects.toThrow(/canonical/u);

    const wrongIdentity = makePortfolioRun("portfolio-run-other");
    const wrongCanonical = canonicalJson(wrongIdentity);
    await writeFile(target, wrongCanonical, "utf8");
    await writeFile(checksumTarget, sha256Hex(wrongCanonical), "utf8");
    await expect(store.readPortfolioRun(run.runId)).rejects.toThrow(/path identity/u);
  });

  it("rejects invalid portfolio run IDs and enforces list bounds", async () => {
    const { store } = await makeStore();

    await expect(store.readPortfolioRun("../escape")).rejects.toThrow();
    await expect(
      store.putPortfolioRun({
        ...makePortfolioRun("portfolio-run-safe"),
        runId: "../escape"
      } as PortfolioRun)
    ).rejects.toThrow();
    await expect(store.listPortfolioRuns(0)).rejects.toThrow(/limit/u);
    await expect(store.listPortfolioRuns(101)).rejects.toThrow(/limit/u);
    await expect(store.listPortfolioRuns(1.5)).rejects.toThrow(/limit/u);
  });

  it("stores portfolio run checkpoints as an append-only ordered stream", async () => {
    const { repositoryRoot, store } = await makeStore();
    const later = makePortfolioCheckpoint("checkpoint-later", 2, {
      status: "succeeded"
    });
    const earlier = makePortfolioCheckpoint("checkpoint-earlier", 1);

    await store.putPortfolioRunCheckpoint(later);
    await store.putPortfolioRunCheckpoint(earlier);

    expect(
      await store.readPortfolioRunCheckpoint(earlier.runId, earlier.checkpointId)
    ).toEqual(earlier);
    expect(await store.listPortfolioRunCheckpoints(earlier.runId)).toEqual([
      earlier,
      later
    ]);
    expect(
      await readdir(
        join(
          repositoryRoot,
          ".local",
          "evidence",
          "portfolio-run-checkpoints",
          earlier.runId
        )
      )
    ).not.toContain("current.json");
    await expect(store.listPortfolioRunCheckpoints(earlier.runId, 0)).rejects.toThrow(
      /limit/u
    );
    await expect(store.listPortfolioRunCheckpoints(earlier.runId, 101)).rejects.toThrow(
      /limit/u
    );
  });

  it("accepts identical checkpoint retries and rejects conflicting checkpoint IDs", async () => {
    const { store } = await makeStore();
    const checkpoint = makePortfolioCheckpoint("checkpoint-conflict", 1);

    const [first, duplicate] = await Promise.all([
      store.putPortfolioRunCheckpoint(checkpoint),
      store.putPortfolioRunCheckpoint(checkpoint)
    ]);
    expect(duplicate).toEqual(first);
    await expect(
      store.putPortfolioRunCheckpoint({
        ...checkpoint,
        status: "failed"
      })
    ).rejects.toThrow(/immutable/u);
  });

  it("stores recommendation decisions idempotently and rejects conflicting events", async () => {
    const { repositoryRoot, store } = await makeStore();
    const event = makeRecommendationDecisionEvent("decision-event-alpha", 1);

    const [first, duplicate] = await Promise.all([
      store.putRecommendationDecisionEvent(event),
      store.putRecommendationDecisionEvent(event)
    ]);
    expect(duplicate).toEqual(first);
    expect(first.relativePath).toBe(
      "recommendation-decision-events/decision-event-alpha.json"
    );
    expect(await store.readRecommendationDecisionEvent(event.eventId)).toEqual(event);
    expect(await store.listRecommendationDecisionEvents()).toEqual([event]);
    expect(
      await readFile(
        join(
          repositoryRoot,
          ".local",
          "evidence",
          "recommendation-decision-events",
          "decision-event-alpha.sha256"
        ),
        "utf8"
      )
    ).toBe(first.sha256);

    await expect(
      store.putRecommendationDecisionEvent({
        ...event,
        reason: "Conflicting immutable event content."
      })
    ).rejects.toThrow(/immutable/u);
  });

  it("selects each requested recommendation's latest validated event without relying on event ID shape", async () => {
    const { store } = await makeStore();
    const events = [
      makeRecommendationDecisionEvent("opaque-alpha-first", 1),
      makeRecommendationDecisionEvent("unrelated-valid-alpha-token", 9),
      makeRecommendationDecisionEvent("opaque-beta-first", 2, {
        recommendationId: "recommendation-beta"
      }),
      makeRecommendationDecisionEvent("another-valid-beta-token", 5, {
        recommendationId: "recommendation-beta"
      }),
      makeRecommendationDecisionEvent("unrequested-gamma-token", 100, {
        recommendationId: "recommendation-gamma"
      })
    ];
    for (const event of events) {
      await store.putRecommendationDecisionEvent(event);
    }

    const recovered = await store.listRecommendationDecisionEvents(2, [
      "recommendation-alpha",
      "recommendation-beta"
    ]);

    expect(recovered).toHaveLength(2);
    expect(
      Object.fromEntries(
        recovered.map((event) => [
          event.recommendationId,
          { eventId: event.eventId, sequence: event.sequence }
        ])
      )
    ).toEqual({
      "recommendation-alpha": {
        eventId: "unrelated-valid-alpha-token",
        sequence: 9
      },
      "recommendation-beta": {
        eventId: "another-valid-beta-token",
        sequence: 5
      }
    });
  });

  it("rejects invalid decision event IDs and enforces event list bounds", async () => {
    const { store } = await makeStore();

    await expect(store.readRecommendationDecisionEvent("../escape")).rejects.toThrow();
    await expect(
      store.putRecommendationDecisionEvent({
        ...makeRecommendationDecisionEvent("decision-event-safe", 1),
        eventId: "../escape"
      } as RecommendationDecisionEvent)
    ).rejects.toThrow();
    await expect(store.listRecommendationDecisionEvents(0)).rejects.toThrow(/limit/u);
    await expect(store.listRecommendationDecisionEvents(101)).rejects.toThrow(/limit/u);
    await expect(store.listRecommendationDecisionEvents(1.5)).rejects.toThrow(/limit/u);
  });

  it("rejects a decision event whose valid content does not match its path identity", async () => {
    const { repositoryRoot, store } = await makeStore();
    const event = makeRecommendationDecisionEvent("decision-event-path", 1);
    const stored = await store.putRecommendationDecisionEvent(event);
    const target = join(repositoryRoot, ".local", "evidence", stored.relativePath);
    const checksumTarget = target.replace(/\.json$/u, ".sha256");
    const wrongIdentity = canonicalJson({
      ...event,
      eventId: "decision-event-other"
    });
    await writeFile(target, wrongIdentity, "utf8");
    await writeFile(checksumTarget, sha256Hex(wrongIdentity), "utf8");

    await expect(
      store.readRecommendationDecisionEvent(event.eventId)
    ).rejects.toThrow(/path identity/u);
  });

  it("rejects a typed artifact symlink even when its target stays inside the repository", async (context) => {
    const { repositoryRoot, store } = await makeStore();
    await store.initialize();
    const evidenceRoot = join(repositoryRoot, ".local", "evidence");
    const portfolioRoot = join(evidenceRoot, "portfolio-runs");
    const source = join(evidenceRoot, "source.json");
    await mkdir(portfolioRoot);
    await writeFile(source, canonicalJson(makePortfolioRun("portfolio-run-link")), "utf8");

    try {
      await symlink(source, join(portfolioRoot, "portfolio-run-link.json"), "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(store.readPortfolioRun("portfolio-run-link")).rejects.toThrow(
      /symbolic link|junction/u
    );
  });
});
