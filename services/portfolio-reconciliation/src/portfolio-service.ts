import {
  PortfolioRecommendationSchema,
  PortfolioRunCheckpointSchema,
  PortfolioRunErrorSchema,
  PortfolioRunSchema,
  RecommendationActionSchema,
  RecommendationDecisionEventSchema,
  SCHEMA_VERSION,
  StableIdSchema,
  UserOverrideReasonCodeSchema,
  type OverlapCluster,
  type PortfolioRecommendation,
  type PortfolioRun,
  type PortfolioRunCheckpoint,
  type RecommendationAction,
  type RecommendationDecisionEvent,
  type RecommendationLifecycle,
  type RepositoryCitation,
  type RepositoryEvidenceBinding,
  type UserOverrideReasonCode
} from "@unified-ai/contracts";
import { canonicalJson, sha256Hex } from "@unified-ai/evidence-index";
import type {
  PortfolioIngestionOptions,
  PortfolioIngestionResult,
  RepositoryInventoryItem,
  RepositoryPortfolioSnapshot
} from "@unified-ai/portfolio-ingestion";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildPortfolioClusters } from "./clusters.js";
import {
  compareProfiles,
  eligibleRecommendationActions,
  evaluateRecommendation
} from "./reconcile.js";
import { buildRepositoryProfileArtifacts } from "./profile.js";
import type {
  ClassifierResult,
  DeterministicRepositoryProfile,
  PortfolioClassifier
} from "./types.js";
import type { RepositoryProfileArtifacts } from "./profile.js";

export interface PortfolioIngestorPort {
  ingestOwnedPortfolio(
    options?: PortfolioIngestionOptions
  ): Promise<PortfolioIngestionResult>;
}

export interface PortfolioEvidencePort {
  putObject(value: unknown): Promise<{ sha256: string; relativePath: string }>;
  readObject(sha256: string): Promise<unknown>;
  putPortfolioRun(run: PortfolioRun): Promise<{ sha256: string; relativePath: string }>;
  listPortfolioRuns(limit?: number): Promise<PortfolioRun[]>;
  putPortfolioRunCheckpoint(
    checkpoint: PortfolioRunCheckpoint
  ): Promise<{ sha256: string; relativePath: string }>;
  listPortfolioRunCheckpoints(
    runId: string,
    limit?: number
  ): Promise<PortfolioRunCheckpoint[]>;
  putRecommendationDecisionEvent(
    event: RecommendationDecisionEvent
  ): Promise<{ sha256: string; relativePath: string }>;
  listRecommendationDecisionEvents(
    limit?: number
  ): Promise<RecommendationDecisionEvent[]>;
}

export interface ChatImportResult {
  snapshots: Array<{
    conversationId: string;
    title: string;
    turns: Array<{ content: string }>;
  }>;
  ingestions: Array<{
    receipt: { receiptId: string };
  }>;
}

export interface PortfolioChatImporter {
  import(input: unknown, projectId: string): Promise<ChatImportResult>;
}

export interface PortfolioRunSummary {
  runId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  createdAt: string;
  completedAt?: string;
  repositoryCount: number;
  completeCount: number;
  incompleteCount: number;
  warningCount: number;
  warnings: string[];
  inventoryFingerprint?: string;
  revisionMismatchCount: number;
}

export interface PortfolioCitationProjection {
  citationId: string;
  family: string;
  locator: string;
  statement: string;
}

export interface PortfolioRepositoryProjection {
  repositoryId: string;
  fullName: string;
  visibility: DeterministicRepositoryProfile["visibility"];
  purpose: string;
  capabilities: string[];
  technologyTags: string[];
  evidenceCoverage: number;
  chatCoverage: number;
  contradictions: string[];
  citations: PortfolioCitationProjection[];
  capturedRevision: string;
  recommendationAction?: RecommendationAction;
}

export interface PortfolioClusterProjection {
  clusterId: string;
  label: string;
  rationale: string;
  sharedCapabilities: string[];
  repositoryIds: string[];
  citationIds: string[];
}

export interface PortfolioRecommendationProjection {
  recommendationId: string;
  repositoryIds: string[];
  action: RecommendationAction;
  lifecycle: RecommendationLifecycle;
  rationale: string;
  confidence: PortfolioRecommendation["confidence"];
  eligibleActions: RecommendationAction[];
  citationIds: string[];
  contradictions: string[];
  decisionHistory: RecommendationDecisionEvent[];
}

interface StoredRecommendation {
  recommendation: PortfolioRecommendation;
  recommendationObjectSha256: string;
  evidenceObjectSha256: string;
  eligibleActions: RecommendationAction[];
  contradictions: string[];
  currentAction: RecommendationAction;
  currentLifecycle: RecommendationLifecycle;
  events: RecommendationDecisionEvent[];
}

interface PortfolioRunState {
  summary: PortfolioRunSummary;
  repositories: PortfolioRepositoryProjection[];
  clusters: PortfolioClusterProjection[];
  recommendations: StoredRecommendation[];
  deterministicProfiles: DeterministicRepositoryProfile[];
}

interface PersistedPortfolioAggregate {
  schemaVersion: "portfolio-analysis/v1";
  runId: string;
  summary: PortfolioRunSummary;
  repositories: PortfolioRepositoryProjection[];
  clusters: PortfolioClusterProjection[];
  recommendations: Array<{
    recommendation: PortfolioRecommendation;
    recommendationObjectSha256: string;
    evidenceObjectSha256: string;
    eligibleActions: RecommendationAction[];
    contradictions: string[];
  }>;
}

const runSummarySchema = z
  .object({
    runId: StableIdSchema,
    status: z.enum(["queued", "running", "succeeded", "failed"]),
    createdAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }).optional(),
    repositoryCount: z.number().int().nonnegative(),
    completeCount: z.number().int().nonnegative(),
    incompleteCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
    warnings: z.array(z.string().max(500)).max(500),
    inventoryFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    revisionMismatchCount: z.number().int().nonnegative()
  })
  .strict();

const citationProjectionSchema = z
  .object({
    citationId: StableIdSchema,
    family: z.string().min(1).max(100),
    locator: z.string().min(1).max(2_000),
    statement: z.string().min(1).max(10_000)
  })
  .strict();

const repositoryProjectionSchema = z
  .object({
    repositoryId: StableIdSchema,
    fullName: z.string().min(1).max(500),
    visibility: z.enum(["public", "private", "internal", "unknown"]),
    purpose: z.string().min(1).max(10_000),
    capabilities: z.array(z.string().min(1).max(500)).max(100),
    technologyTags: z.array(z.string().min(1).max(200)).max(100),
    evidenceCoverage: z.number().finite().min(0).max(1),
    chatCoverage: z.number().int().nonnegative(),
    contradictions: z.array(z.string().min(1).max(10_000)).max(100),
    citations: z.array(citationProjectionSchema).min(1).max(500),
    capturedRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
    recommendationAction: RecommendationActionSchema.optional()
  })
  .strict();

const clusterProjectionSchema = z
  .object({
    clusterId: StableIdSchema,
    label: z.string().min(1).max(500),
    rationale: z.string().min(1).max(10_000),
    sharedCapabilities: z.array(z.string().min(1).max(500)).min(1).max(100),
    repositoryIds: z.array(StableIdSchema).min(2).max(100),
    citationIds: z.array(StableIdSchema).min(1).max(500)
  })
  .strict();

const persistedRecommendationSchema = z
  .object({
    recommendation: PortfolioRecommendationSchema,
    recommendationObjectSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    evidenceObjectSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    eligibleActions: z.array(RecommendationActionSchema).min(1).max(6),
    contradictions: z.array(z.string().min(1).max(10_000)).max(100)
  })
  .strict()
  .superRefine((stored, context) => {
    if (stored.evidenceObjectSha256 !== stored.recommendation.evidenceObjectSha256) {
      context.addIssue({
        code: "custom",
        message: "recommendation evidence hash does not match",
        path: ["evidenceObjectSha256"]
      });
    }
  });

const persistedPortfolioAggregateSchema = z
  .object({
    schemaVersion: z.literal("portfolio-analysis/v1"),
    runId: StableIdSchema,
    summary: runSummarySchema,
    repositories: z.array(repositoryProjectionSchema).min(1).max(100),
    clusters: z.array(clusterProjectionSchema).max(100),
    recommendations: z.array(persistedRecommendationSchema).min(1).max(100)
  })
  .strict()
  .superRefine((aggregate, context) => {
    if (aggregate.summary.runId !== aggregate.runId) {
      context.addIssue({
        code: "custom",
        message: "aggregate summary runId does not match",
        path: ["summary", "runId"]
      });
    }
    if (
      aggregate.summary.repositoryCount !== aggregate.repositories.length ||
      aggregate.recommendations.length !== aggregate.repositories.length
    ) {
      context.addIssue({
        code: "custom",
        message: "aggregate repository and recommendation counts do not match",
        path: ["repositories"]
      });
    }
  });

export interface PortfolioServiceOptions {
  owner: string;
  orchestratorFullName: string;
  ingestor: PortfolioIngestorPort;
  evidence: PortfolioEvidencePort;
  classifier?: PortfolioClassifier;
  chatImporter?: PortfolioChatImporter;
  now?: () => Date;
  runId?: () => string;
}

function hash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function runId(): string {
  return `portfolio-run-${randomUUID()}`;
}

function safeWarning(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.slice(0, 500);
  }
  return "Portfolio run failed safely.";
}

function coverage(profile: DeterministicRepositoryProfile): number {
  const states = Object.values(profile.evidenceFamilies);
  return states.filter((state) => state === "complete").length / states.length;
}

function citationProjection(
  citation: RepositoryCitation
): PortfolioCitationProjection {
  return {
    citationId: citation.citationId,
    family: citation.family,
    locator: citation.locator,
    statement: citation.statement
  };
}

function repositoryProjection(
  profile: DeterministicRepositoryProfile,
  chatCoverage: number
): PortfolioRepositoryProjection {
  return {
    repositoryId: profile.binding.repositoryId,
    fullName: profile.fullName,
    visibility: profile.visibility,
    purpose: profile.purpose,
    capabilities: profile.capabilities,
    technologyTags: profile.technologyTags,
    evidenceCoverage: coverage(profile),
    chatCoverage,
    contradictions: [...profile.contradictions],
    citations: profile.citations.map(citationProjection),
    capturedRevision: profile.binding.capturedRevision
  };
}

function clusterProjection(cluster: OverlapCluster): PortfolioClusterProjection {
  return {
    clusterId: cluster.clusterId,
    label: cluster.label,
    rationale: cluster.rationale,
    sharedCapabilities: cluster.sharedCapabilities,
    repositoryIds: cluster.repositories.map(
      (repository) => repository.repositoryId
    ),
    citationIds: cluster.citationIds
  };
}

function recommendationProjection(
  stored: StoredRecommendation
): PortfolioRecommendationProjection {
  return {
    recommendationId: stored.recommendation.recommendationId,
    repositoryIds: stored.recommendation.repositories.map(
      (repository) => repository.repositoryId
    ),
    action: stored.currentAction,
    lifecycle: stored.currentLifecycle,
    rationale: stored.recommendation.rationale,
    confidence: stored.recommendation.confidence,
    eligibleActions: stored.eligibleActions,
    citationIds: stored.recommendation.citationIds,
    contradictions: stored.contradictions,
    decisionHistory: stored.events
  };
}

function matchingInventory(
  inventory: readonly RepositoryInventoryItem[],
  snapshot: RepositoryPortfolioSnapshot
): RepositoryInventoryItem | undefined {
  const requested = snapshot.requestedFullName.toLowerCase();
  return inventory.find(
    (item) =>
      item.fullName.toLowerCase() === requested ||
      item.fullName.toLowerCase() === snapshot.fullName.toLowerCase()
  );
}

function linkedRepositories(
  action: RecommendationAction,
  subject: DeterministicRepositoryProfile,
  peers: readonly DeterministicRepositoryProfile[]
): RepositoryEvidenceBinding[] {
  if (action !== "combine-with-peer" && action !== "extract-shared-component") {
    return [subject.binding];
  }
  const eligible = peers
    .filter((peer) => peer.binding.repositoryId !== subject.binding.repositoryId)
    .filter((peer) => {
      const overlap = compareProfiles(subject, peer);
      return action === "combine-with-peer"
        ? overlap.samePurpose && overlap.jaccard >= 0.6
        : !overlap.samePurpose &&
            overlap.sharedCapabilities.length >= 2 &&
            overlap.jaccard >= 0.3;
    })
    .sort((left, right) =>
      left.binding.repositoryId.localeCompare(right.binding.repositoryId)
    );
  return [subject.binding, ...(eligible[0] ? [eligible[0].binding] : [])];
}

function chatMatchesRepository(
  fullName: string,
  conversation: ChatImportResult["snapshots"][number]
): boolean {
  const name = fullName.split("/").at(-1)?.toLowerCase() ?? fullName.toLowerCase();
  const aliases = new Set([
    name,
    name.replace(/[-_]+/gu, " "),
    fullName.toLowerCase()
  ]);
  const text = `${conversation.title}\n${conversation.turns
    .map((turn) => turn.content)
    .join("\n")}`.toLowerCase();
  return [...aliases].some((alias) => alias.length >= 3 && text.includes(alias));
}

export class PortfolioService {
  readonly #owner: string;
  readonly #orchestratorFullName: string;
  readonly #ingestor: PortfolioIngestorPort;
  readonly #evidence: PortfolioEvidencePort;
  readonly #classifier: PortfolioClassifier | undefined;
  readonly #chatImporter: PortfolioChatImporter | undefined;
  readonly #now: () => Date;
  readonly #runId: () => string;
  readonly #runs = new Map<string, PortfolioRunState>();
  readonly #active = new Map<string, Promise<void>>();
  readonly #chatSnapshots: ChatImportResult["snapshots"] = [];

  constructor(options: PortfolioServiceOptions) {
    this.#owner = options.owner.toLowerCase();
    this.#orchestratorFullName = options.orchestratorFullName.toLowerCase();
    this.#ingestor = options.ingestor;
    this.#evidence = options.evidence;
    this.#classifier = options.classifier;
    this.#chatImporter = options.chatImporter;
    this.#now = options.now ?? (() => new Date());
    this.#runId = options.runId ?? runId;
  }

  async initialize(): Promise<void> {
    const [runs, events] = await Promise.all([
      this.#evidence.listPortfolioRuns(20),
      this.#evidence.listRecommendationDecisionEvents(100)
    ]);
    for (const run of runs.reverse()) {
      try {
        const aggregate = persistedPortfolioAggregateSchema.parse(
          await this.#evidence.readObject(run.evidenceObjectSha256)
        );
        if (
          aggregate.runId !== run.runId ||
          run.repositories.length !== aggregate.repositories.length ||
          run.repositories.some((binding) => {
            const repository = aggregate.repositories.find(
              (candidate) => candidate.repositoryId === binding.repositoryId
            );
            return (
              repository === undefined ||
              repository.capturedRevision !== binding.capturedRevision
            );
          })
        ) {
          throw new Error("stored portfolio aggregate failed run identity binding");
        }
        const recommendations = aggregate.recommendations.map((stored) => {
          const history = events
            .filter(
              (event) =>
                event.runId === run.runId &&
                event.recommendationId ===
                  stored.recommendation.recommendationId &&
                event.recommendationObjectSha256 ===
                  stored.recommendationObjectSha256
            )
            .sort((left, right) => left.sequence - right.sequence);
          const latest = history.at(-1);
          return {
            ...stored,
            currentAction: latest?.action ?? stored.recommendation.action,
            currentLifecycle:
              latest?.lifecycle ?? stored.recommendation.lifecycle,
            events: history
          } satisfies StoredRecommendation;
        });
        const recoveredSummary: PortfolioRunSummary = {
          runId: aggregate.summary.runId,
          status: aggregate.summary.status,
          createdAt: aggregate.summary.createdAt,
          ...(aggregate.summary.completedAt === undefined
            ? {}
            : { completedAt: aggregate.summary.completedAt }),
          repositoryCount: aggregate.summary.repositoryCount,
          completeCount: aggregate.summary.completeCount,
          incompleteCount: aggregate.summary.incompleteCount,
          warningCount: aggregate.summary.warningCount,
          warnings: aggregate.summary.warnings,
          ...(aggregate.summary.inventoryFingerprint === undefined
            ? {}
            : {
                inventoryFingerprint:
                  aggregate.summary.inventoryFingerprint
              }),
          revisionMismatchCount: aggregate.summary.revisionMismatchCount
        };
        const recoveredRepositories: PortfolioRepositoryProjection[] =
          aggregate.repositories.map((repository) => ({
            repositoryId: repository.repositoryId,
            fullName: repository.fullName,
            visibility: repository.visibility,
            purpose: repository.purpose,
            capabilities: repository.capabilities,
            technologyTags: repository.technologyTags,
            evidenceCoverage: repository.evidenceCoverage,
            chatCoverage: repository.chatCoverage,
            contradictions: repository.contradictions,
            citations: repository.citations,
            capturedRevision: repository.capturedRevision,
            ...(repository.recommendationAction === undefined
              ? {}
              : {
                  recommendationAction:
                    repository.recommendationAction
                })
          }));
        this.#runs.set(run.runId, {
          summary: recoveredSummary,
          repositories: recoveredRepositories,
          clusters: aggregate.clusters,
          recommendations,
          deterministicProfiles: []
        });
      } catch {
        this.#runs.set(run.runId, {
          summary: {
            runId: run.runId,
            status: "failed",
            createdAt: run.createdAt,
            completedAt: run.createdAt,
            repositoryCount: run.repositories.length,
            completeCount: 0,
            incompleteCount: run.repositories.length,
            warningCount: 1,
            warnings: [
              "Stored portfolio analysis failed its integrity or schema validation."
            ],
            revisionMismatchCount: 0
          },
          repositories: [],
          clusters: [],
          recommendations: [],
          deterministicProfiles: []
        });
      }
    }
  }

  startRun(): PortfolioRunSummary {
    if ([...this.#active.values()].length > 0) {
      throw new Error("A portfolio refresh is already running.");
    }
    const createdAt = this.#now().toISOString();
    const summary: PortfolioRunSummary = {
      runId: StableIdSchema.parse(this.#runId()),
      status: "queued",
      createdAt,
      repositoryCount: 0,
      completeCount: 0,
      incompleteCount: 0,
      warningCount: 0,
      warnings: [],
      revisionMismatchCount: 0
    };
    const state: PortfolioRunState = {
      summary,
      repositories: [],
      clusters: [],
      recommendations: [],
      deterministicProfiles: []
    };
    this.#runs.set(summary.runId, state);
    const queued = { ...summary, warnings: [...summary.warnings] };
    const execution = this.#execute(state)
      .catch((error: unknown) => {
        state.summary.status = "failed";
        state.summary.completedAt = this.#now().toISOString();
        state.summary.warnings.push(safeWarning(error));
        state.summary.warningCount = state.summary.warnings.length;
      })
      .finally(() => this.#active.delete(summary.runId));
    this.#active.set(summary.runId, execution);
    return queued;
  }

  async waitForRun(runIdValue: string): Promise<PortfolioRunSummary> {
    const parsedRunId = StableIdSchema.parse(runIdValue);
    await this.#active.get(parsedRunId);
    return this.getRun(parsedRunId);
  }

  listRuns(): PortfolioRunSummary[] {
    return [...this.#runs.values()]
      .map((state) => ({ ...state.summary, warnings: [...state.summary.warnings] }))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }

  getRun(runIdValue: string): PortfolioRunSummary {
    const parsedRunId = StableIdSchema.parse(runIdValue);
    const state = this.#runs.get(parsedRunId);
    if (state === undefined) {
      throw new Error("Portfolio run was not found.");
    }
    return { ...state.summary, warnings: [...state.summary.warnings] };
  }

  listRepositories(): PortfolioRepositoryProjection[] {
    return this.#latest()?.repositories.map((repository) => ({
      ...repository,
      capabilities: [...repository.capabilities],
      technologyTags: [...repository.technologyTags],
      contradictions: [...repository.contradictions],
      citations: repository.citations.map((citation) => ({ ...citation }))
    })) ?? [];
  }

  getRepository(repositoryId: string): PortfolioRepositoryProjection {
    const parsedId = StableIdSchema.parse(repositoryId);
    const repository = this.listRepositories().find(
      (candidate) => candidate.repositoryId === parsedId
    );
    if (repository === undefined) {
      throw new Error("Portfolio repository was not found.");
    }
    return repository;
  }

  listClusters(): PortfolioClusterProjection[] {
    return this.#latest()?.clusters.map((cluster) => ({
      ...cluster,
      sharedCapabilities: [...cluster.sharedCapabilities],
      repositoryIds: [...cluster.repositoryIds],
      citationIds: [...cluster.citationIds]
    })) ?? [];
  }

  getCluster(clusterId: string): PortfolioClusterProjection {
    const parsedId = StableIdSchema.parse(clusterId);
    const cluster = this.listClusters().find(
      (candidate) => candidate.clusterId === parsedId
    );
    if (cluster === undefined) {
      throw new Error("Portfolio cluster was not found.");
    }
    return cluster;
  }

  listRecommendations(): PortfolioRecommendationProjection[] {
    return this.#latest()?.recommendations.map(recommendationProjection) ?? [];
  }

  getRecommendation(
    recommendationId: string
  ): PortfolioRecommendationProjection {
    const parsedId = StableIdSchema.parse(recommendationId);
    const recommendation = this.listRecommendations().find(
      (candidate) => candidate.recommendationId === parsedId
    );
    if (recommendation === undefined) {
      throw new Error("Portfolio recommendation was not found.");
    }
    return recommendation;
  }

  async overrideRecommendation(input: {
    recommendationId: string;
    action: RecommendationAction;
    reasonCode: UserOverrideReasonCode;
    explanation: string;
    providedBy: string;
  }): Promise<PortfolioRecommendationProjection> {
    const state = this.#latest();
    if (state === undefined) {
      throw new Error("No completed portfolio run is available.");
    }
    const recommendationId = StableIdSchema.parse(input.recommendationId);
    const stored = state.recommendations.find(
      (candidate) =>
        candidate.recommendation.recommendationId === recommendationId
    );
    if (stored === undefined) {
      throw new Error("Portfolio recommendation was not found.");
    }
    const action = RecommendationActionSchema.parse(input.action);
    const reasonCode = UserOverrideReasonCodeSchema.parse(input.reasonCode);
    const providedBy = StableIdSchema.parse(input.providedBy);
    const occurredAt = this.#now().toISOString();
    const receipt = await this.#evidence.putObject({
      schemaVersion: SCHEMA_VERSION,
      kind: "portfolio-recommendation-override-receipt",
      recommendationId,
      runId: stored.recommendation.runId,
      previousLifecycle: stored.currentLifecycle,
      previousAction: stored.currentAction,
      action,
      reasonCode,
      explanationSha256: sha256Hex(input.explanation),
      providedBy,
      occurredAt
    });
    const event = RecommendationDecisionEventSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      eventId: `decision-${recommendationId}-${stored.events.length + 1}`,
      recommendationId,
      runId: stored.recommendation.runId,
      sequence: stored.events.length + 1,
      actor: "user",
      previousLifecycle: stored.currentLifecycle,
      previousAction: stored.currentAction,
      lifecycle: "overridden",
      action,
      occurredAt,
      recommendationObjectSha256: stored.recommendationObjectSha256,
      evidenceObjectSha256: stored.evidenceObjectSha256,
      receiptObjectSha256: receipt.sha256,
      repositories: stored.recommendation.repositories,
      reason: input.explanation,
      override: {
        reasonCode,
        explanation: input.explanation,
        providedBy,
        providedAt: occurredAt
      }
    });
    await this.#evidence.putRecommendationDecisionEvent(event);
    stored.events.push(event);
    stored.currentAction = action;
    stored.currentLifecycle = "overridden";
    return recommendationProjection(stored);
  }

  async importChat(input: unknown, projectId: string): Promise<{
    importedCount: number;
    receiptId: string;
    receiptIds: string[];
  }> {
    if (this.#chatImporter === undefined) {
      throw new Error("ChatGPT import is unavailable.");
    }
    const parsedProjectId = StableIdSchema.parse(projectId);
    const result = await this.#chatImporter.import(input, parsedProjectId);
    this.#chatSnapshots.push(...result.snapshots);
    const receiptIds = result.ingestions.map(
      (ingestion) => ingestion.receipt.receiptId
    );
    return {
      importedCount: result.snapshots.length,
      receiptId: receiptIds.at(-1) ?? "receipt-none",
      receiptIds
    };
  }

  async #execute(state: PortfolioRunState): Promise<void> {
    state.summary.status = "running";
    const ingestion = await this.#ingestor.ingestOwnedPortfolio();
    if (!ingestion.inventoryComplete || ingestion.inventory.length === 0) {
      throw new Error("GitHub did not provide a complete owned-repository inventory.");
    }
    if (
      ingestion.inventory.some(
        (repository) => repository.owner.toLowerCase() !== this.#owner
      )
    ) {
      throw new Error("GitHub inventory owner does not match the configured account.");
    }
    if (
      !ingestion.inventory.some(
        (repository) =>
          repository.fullName.toLowerCase() === this.#orchestratorFullName
      )
    ) {
      throw new Error("The authoritative inventory does not include this orchestrator.");
    }
    const sourceInventory = ingestion.inventory.filter(
      (repository) =>
        repository.fullName.toLowerCase() !== this.#orchestratorFullName
    );
    const sourceSnapshots = ingestion.repositories.filter(
      (snapshot) =>
        snapshot.requestedFullName.toLowerCase() !== this.#orchestratorFullName
    );
    if (sourceInventory.length === 0 || sourceSnapshots.length !== sourceInventory.length) {
      throw new Error("GitHub source-repository inventory and snapshots are inconsistent.");
    }

    const artifacts: RepositoryProfileArtifacts[] = [];
    for (const snapshot of sourceSnapshots) {
      const inventory = matchingInventory(sourceInventory, snapshot);
      if (inventory === undefined) {
        throw new Error("A repository snapshot has no authoritative inventory identity.");
      }
      const artifact = buildRepositoryProfileArtifacts({
        inventory,
        snapshot,
        capturedAt: ingestion.completedAt,
        orchestratorFullName: this.#orchestratorFullName
      });
      for (const evidenceObject of artifact.evidenceObjects) {
        const stored = await this.#evidence.putObject(evidenceObject.value);
        if (stored.sha256 !== evidenceObject.sha256) {
          throw new Error("Stored portfolio evidence failed its content hash binding.");
        }
      }
      const bindingObject = await this.#evidence.putObject({
        repositoryId: artifact.deterministic.binding.repositoryId,
        revision: artifact.deterministic.binding.capturedRevision,
        evidence: artifact.snapshot.evidence
      });
      if (bindingObject.sha256 !== artifact.deterministic.binding.evidenceObjectSha256) {
        throw new Error("Repository binding evidence failed its content hash binding.");
      }
      await Promise.all([
        this.#evidence.putObject(artifact.snapshot),
        this.#evidence.putObject(artifact.profile),
        ...artifact.citations.map((citation) => this.#evidence.putObject(citation))
      ]);
      artifacts.push(artifact);
    }
    const profiles = artifacts.map((artifact) => artifact.deterministic);
    for (const profile of profiles) {
      const matches = this.#chatSnapshots.filter((conversation) =>
        chatMatchesRepository(profile.fullName, conversation)
      );
      if (
        matches.some((conversation) =>
          /\b(not implemented|not deployed|failed deployment|did not work|didn't work)\b/iu.test(
            conversation.turns.map((turn) => turn.content).join("\n")
          )
        )
      ) {
        profile.contradictions.push(
          "ChatGPT intent evidence reports an implementation limitation; repository evidence remains authoritative."
        );
      }
    }

    const clusterResult = buildPortfolioClusters(profiles, ingestion.completedAt);
    for (const cluster of clusterResult.clusters) {
      const component = cluster.repositories
        .map((repository) => repository.repositoryId)
        .sort();
      const stored = await this.#evidence.putObject({
        component,
        sharedCapabilities: cluster.sharedCapabilities
      });
      if (stored.sha256 !== cluster.evidenceObjectSha256) {
        throw new Error("Overlap cluster failed its content hash binding.");
      }
      await this.#evidence.putObject(cluster);
    }

    const storedRecommendations: StoredRecommendation[] = [];
    const classifierWarnings: string[] = [];
    for (const profile of profiles) {
      const eligibleActions = eligibleRecommendationActions(profile, profiles, this.#now());
      let classifier: ClassifierResult = {
        first: null,
        second: null,
        warnings: ["Ollama classification was not configured; deterministic rules remain authoritative."]
      };
      if (this.#classifier !== undefined) {
        classifier = await this.#classifier.classify(profile, eligibleActions);
      }
      const evaluation = evaluateRecommendation({
        profile,
        peers: profiles,
        classifier,
        now: this.#now()
      });
      classifierWarnings.push(...evaluation.warnings);
      const repositories = linkedRepositories(
        evaluation.action,
        profile,
        profiles
      );
      const recommendationId = `recommendation-${state.summary.runId.replace(/^portfolio-run-/u, "")}-${profile.binding.repositoryId.replace(/^repository-/u, "")}`;
      const clusterId = clusterResult.clusters.find((cluster) =>
        cluster.repositories.some(
          (repository) =>
            repository.repositoryId === profile.binding.repositoryId
        )
      )?.clusterId;
      const recommendationEvidence = await this.#evidence.putObject({
        schemaVersion: SCHEMA_VERSION,
        kind: "portfolio-recommendation-evidence",
        runId: state.summary.runId,
        repositoryId: profile.binding.repositoryId,
        action: evaluation.action,
        eligibleActions: evaluation.eligibleActions,
        confidence: evaluation.confidence,
        citationIds: evaluation.citationIds,
        contradictions: profile.contradictions
      });
      const recommendation = PortfolioRecommendationSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        recommendationId,
        runId: state.summary.runId,
        ...(clusterId === undefined ? {} : { clusterId }),
        action: evaluation.action,
        lifecycle: evaluation.lifecycle,
        createdAt: ingestion.completedAt,
        evidenceObjectSha256: recommendationEvidence.sha256,
        repositories,
        citationIds: [
          ...new Set([
            ...evaluation.citationIds,
            ...repositories.flatMap((binding) =>
              profiles
                .find(
                  (candidate) =>
                    candidate.binding.repositoryId === binding.repositoryId
                )
                ?.citations.map((citation) => citation.citationId) ?? []
            )
          ])
        ].sort(),
        rationale: evaluation.rationale,
        confidence: evaluation.confidence
      });
      const recommendationObject = await this.#evidence.putObject(recommendation);
      const eventReceipt = await this.#evidence.putObject({
        schemaVersion: SCHEMA_VERSION,
        kind: "portfolio-recommendation-decision-receipt",
        recommendationId,
        runId: state.summary.runId,
        action: recommendation.action,
        lifecycle: recommendation.lifecycle,
        occurredAt: ingestion.completedAt
      });
      const event = RecommendationDecisionEventSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        eventId: `decision-${recommendationId}-0`,
        recommendationId,
        runId: state.summary.runId,
        sequence: 0,
        actor: "system",
        lifecycle: recommendation.lifecycle,
        action: recommendation.action,
        occurredAt: ingestion.completedAt,
        recommendationObjectSha256: recommendationObject.sha256,
        evidenceObjectSha256: recommendation.evidenceObjectSha256,
        receiptObjectSha256: eventReceipt.sha256,
        repositories: recommendation.repositories,
        reason: evaluation.autoFinalizationEligible
          ? "The exact evidence, citation, classifier, confidence, and deterministic rule gate passed."
          : "The recommendation remains local and requires its recorded lifecycle gate."
      });
      await this.#evidence.putRecommendationDecisionEvent(event);
      storedRecommendations.push({
        recommendation,
        recommendationObjectSha256: recommendationObject.sha256,
        evidenceObjectSha256: recommendation.evidenceObjectSha256,
        eligibleActions: evaluation.eligibleActions,
        contradictions: [...profile.contradictions],
        currentAction: recommendation.action,
        currentLifecycle: recommendation.lifecycle,
        events: [event]
      });
    }

    const sourceByName = new Map(
      sourceSnapshots.map((snapshot) => [snapshot.requestedFullName.toLowerCase(), snapshot])
    );
    const revisionMismatchCount = sourceInventory.filter((repository) => {
      const snapshot = sourceByName.get(repository.fullName.toLowerCase());
      return (
        snapshot?.beforeRef !== undefined &&
        snapshot.afterRef !== undefined &&
        (snapshot.beforeRef.commitSha !== snapshot.afterRef.commitSha ||
          snapshot.beforeRef.treeSha !== snapshot.afterRef.treeSha)
      );
    }).length;
    const repositories = profiles.map((profile) => {
      const projection = repositoryProjection(
        profile,
        this.#chatSnapshots.filter((conversation) =>
          chatMatchesRepository(profile.fullName, conversation)
        ).length
      );
      const recommendation = storedRecommendations.find((candidate) =>
        candidate.recommendation.repositories.some(
          (binding) => binding.repositoryId === profile.binding.repositoryId
        )
      );
      return {
        ...projection,
        ...(recommendation === undefined
          ? {}
          : { recommendationAction: recommendation.currentAction })
      };
    });
    state.repositories = repositories;
    state.clusters = clusterResult.clusters.map(clusterProjection);
    state.recommendations = storedRecommendations;
    state.deterministicProfiles = profiles;
    state.summary.repositoryCount = repositories.length;
    state.summary.completeCount = repositories.filter(
      (repository) => repository.evidenceCoverage === 1
    ).length;
    state.summary.incompleteCount =
      repositories.length - state.summary.completeCount;
    state.summary.warnings = [...ingestion.warnings, ...classifierWarnings];
    state.summary.warningCount = state.summary.warnings.length;
    state.summary.inventoryFingerprint = hash(
      sourceInventory
        .map((repository) => ({
          id: repository.id,
          fullName: repository.fullName,
          visibility: repository.visibility,
          defaultBranch: repository.defaultBranch
        }))
        .sort((left, right) => left.fullName.localeCompare(right.fullName))
    );
    state.summary.revisionMismatchCount = revisionMismatchCount;
    state.summary.status = "succeeded";
    state.summary.completedAt = this.#now().toISOString();

    const aggregate: PersistedPortfolioAggregate = {
      schemaVersion: "portfolio-analysis/v1",
      runId: state.summary.runId,
      summary: state.summary,
      repositories: state.repositories,
      clusters: state.clusters,
      recommendations: storedRecommendations.map((stored) => ({
        recommendation: stored.recommendation,
        recommendationObjectSha256: stored.recommendationObjectSha256,
        evidenceObjectSha256: stored.evidenceObjectSha256,
        eligibleActions: stored.eligibleActions,
        contradictions: stored.contradictions
      }))
    };
    const aggregateObject = await this.#evidence.putObject(aggregate);
    const run = PortfolioRunSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      runId: state.summary.runId,
      createdAt: state.summary.createdAt,
      evidenceObjectSha256: aggregateObject.sha256,
      repositories: profiles.map((profile) => profile.binding)
    });
    await this.#evidence.putPortfolioRun(run);

    const checkpointErrors = [];
    for (const [index, gap] of ingestion.gaps.entries()) {
      const snapshot = sourceSnapshots.find((candidate) => gap.url.includes(candidate.fullName));
      const profile = snapshot === undefined
        ? undefined
        : profiles.find((candidate) => candidate.fullName === snapshot.fullName);
      const errorEvidence = await this.#evidence.putObject({
        schemaVersion: SCHEMA_VERSION,
        kind: "portfolio-ingestion-gap",
        runId: run.runId,
        gap
      });
      checkpointErrors.push(
        PortfolioRunErrorSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          errorId: `portfolio-error-${index + 1}-${gap.reason}`,
          runId: run.runId,
          code: gap.reason,
          message: gap.detail,
          retryable: gap.reason === "rate-limited" || gap.reason === "network-error",
          occurredAt: ingestion.completedAt,
          evidenceObjectSha256: errorEvidence.sha256,
          ...(profile === undefined ? {} : { repository: profile.binding })
        })
      );
    }
    const checkpoint = PortfolioRunCheckpointSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      checkpointId: `checkpoint-${run.runId}-0`,
      runId: run.runId,
      sequence: 0,
      status: "succeeded",
      occurredAt: state.summary.completedAt,
      evidenceObjectSha256: aggregateObject.sha256,
      repositories: run.repositories,
      errors: checkpointErrors
    });
    await this.#evidence.putPortfolioRunCheckpoint(checkpoint);
  }

  #latest(): PortfolioRunState | undefined {
    let latest: PortfolioRunState | undefined;
    for (const state of this.#runs.values()) {
      if (
        state.summary.status === "succeeded" &&
        (latest === undefined ||
          Date.parse(state.summary.createdAt) >=
            Date.parse(latest.summary.createdAt))
      ) {
        latest = state;
      }
    }
    return latest;
  }
}
