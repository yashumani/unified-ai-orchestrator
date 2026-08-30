import {
  AgentRunReceiptSchema,
  EvidenceReceiptSchema,
  PortfolioRunCheckpointSchema,
  PortfolioRunSchema,
  RecommendationDecisionEventSchema,
  Sha256Schema,
  StableIdSchema,
  type AgentRunReceipt,
  type EvidenceReceipt,
  type PortfolioRun,
  type PortfolioRunCheckpoint,
  type RecommendationDecisionEvent
} from "@unified-ai/contracts";
import {
  DashboardBuildReceiptSchema,
  DashboardImportReceiptSchema,
  DashboardTemplateEventSchema,
  type DashboardBuildReceipt,
  type DashboardImportReceipt,
  type DashboardTemplateEvent
} from "@unified-ai/contracts/dashboard-builder";
import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical-json.js";

export interface LocalEvidenceStoreOptions {
  root: string;
  repositoryRoot: string;
}

export interface StoredObject {
  sha256: string;
  relativePath: string;
}

const DEFAULT_AGENT_RUN_RECEIPT_LIMIT = 20;
const MAX_AGENT_RUN_RECEIPT_LIMIT = 100;
const DEFAULT_PORTFOLIO_ARTIFACT_LIMIT = 20;
const MAX_PORTFOLIO_ARTIFACT_LIMIT = 100;

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

export function resolveWithinRoot(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, ...segments);

  if (!isContained(resolvedRoot, candidate)) {
    throw new Error("evidence path escapes the configured local root");
  }

  return candidate;
}

function assertListLimit(limit: number, label: string): void {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_PORTFOLIO_ARTIFACT_LIMIT
  ) {
    throw new Error(
      `${label} limit must be an integer from 1 to ${MAX_PORTFOLIO_ARTIFACT_LIMIT}`
    );
  }
}

export class LocalEvidenceStore {
  readonly root: string;
  readonly repositoryRoot: string;
  #realRoot: string | undefined;
  #rootIdentity: DirectoryIdentity | undefined;
  #realRepositoryRoot: string | undefined;
  #repositoryIdentity: DirectoryIdentity | undefined;

  constructor(options: LocalEvidenceStoreOptions) {
    if (!isAbsolute(options.root) || !isAbsolute(options.repositoryRoot)) {
      throw new Error("evidence and repository roots must be absolute paths");
    }

    this.root = resolve(options.root);
    this.repositoryRoot = resolve(options.repositoryRoot);

    if (this.root === this.repositoryRoot) {
      throw new Error("the repository root cannot be used as the evidence root");
    }

    if (!isContained(this.repositoryRoot, this.root)) {
      throw new Error(
        "the evidence root must be a lexical descendant of the repository root"
      );
    }
  }

  async initialize(): Promise<void> {
    const resolvedRepositoryRoot = await realpath(this.repositoryRoot);
    const repositoryStats = await lstat(resolvedRepositoryRoot);
    if (!repositoryStats.isDirectory()) {
      throw new Error("the canonical repository root must be a directory");
    }

    const repositoryIdentity = {
      dev: repositoryStats.dev,
      ino: repositoryStats.ino
    };
    if (this.#realRepositoryRoot === undefined) {
      this.#realRepositoryRoot = resolvedRepositoryRoot;
      this.#repositoryIdentity = repositoryIdentity;
    } else if (
      resolvedRepositoryRoot !== this.#realRepositoryRoot ||
      !this.#hasSameIdentity(this.#repositoryIdentity, repositoryIdentity)
    ) {
      throw new Error("the repository root changed since evidence initialization");
    }

    const pathFromRepository = relative(this.repositoryRoot, this.root);
    let current = resolvedRepositoryRoot;
    for (const segment of pathFromRepository.split(sep).filter(Boolean)) {
      const candidate = resolveWithinRoot(current, segment);
      let candidateStats;
      try {
        candidateStats = await lstat(candidate);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" ||
          this.#realRoot !== undefined
        ) {
          throw error;
        }
        try {
          await mkdir(candidate);
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
            throw mkdirError;
          }
        }
        candidateStats = await lstat(candidate);
      }

      if (candidateStats.isSymbolicLink()) {
        throw new Error(
          "the evidence root cannot traverse a symbolic link or junction"
        );
      }
      if (!candidateStats.isDirectory()) {
        throw new Error("every evidence root component must be a directory");
      }
      current = candidate;
    }

    const resolvedRoot = await realpath(this.root);

    if (
      resolvedRoot === resolvedRepositoryRoot ||
      !isContained(resolvedRepositoryRoot, resolvedRoot)
    ) {
      throw new Error(
        "the resolved evidence root must remain inside the canonical repository"
      );
    }

    const rootStats = await lstat(this.root);
    if (rootStats.isSymbolicLink()) {
      throw new Error("the evidence root cannot be a symbolic link or junction");
    }
    const rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };
    if (this.#realRoot === undefined) {
      this.#realRoot = resolvedRoot;
      this.#rootIdentity = rootIdentity;
    } else if (
      resolvedRoot !== this.#realRoot ||
      !this.#hasSameIdentity(this.#rootIdentity, rootIdentity)
    ) {
      throw new Error("the evidence root changed since initialization");
    }
  }

  async putObject(value: unknown): Promise<StoredObject> {
    const canonical = canonicalJson(value);
    const sha256 = sha256Hex(canonical);
    const target = await this.#objectPath(sha256);

    await this.#writeImmutable(target, canonical);

    return {
      sha256,
      relativePath: relative(await this.#rootPath(), target).replaceAll("\\", "/")
    };
  }

  async readObject(sha256: string): Promise<unknown> {
    const parsedHash = Sha256Schema.parse(sha256);
    const target = await this.#objectPath(parsedHash);
    const realTarget = await realpath(target);
    this.#assertContained(realTarget);

    const content = await readFile(realTarget, "utf8");
    if (sha256Hex(content) !== parsedHash) {
      throw new Error("stored evidence failed its SHA-256 integrity check");
    }

    return JSON.parse(content) as unknown;
  }

  async putReceipt(receipt: EvidenceReceipt): Promise<StoredObject> {
    const parsed = EvidenceReceiptSchema.parse(receipt);
    const canonical = canonicalJson(parsed);
    const root = await this.#rootPath();
    const target = resolveWithinRoot(root, "receipts", `${parsed.receiptId}.json`);

    await this.#writeImmutable(target, canonical);

    return {
      sha256: sha256Hex(canonical),
      relativePath: relative(root, target).replaceAll("\\", "/")
    };
  }

  async putAgentRunReceipt(receipt: AgentRunReceipt): Promise<StoredObject> {
    const parsed = AgentRunReceiptSchema.parse(receipt);
    const runId = StableIdSchema.parse(parsed.runId);
    const canonical = canonicalJson(parsed);
    const sha256 = sha256Hex(canonical);
    const root = await this.#rootPath();
    const target = resolveWithinRoot(root, "agent-runs", `${runId}.json`);
    const checksumTarget = resolveWithinRoot(
      root,
      "agent-runs",
      `${runId}.sha256`
    );

    await this.#writeImmutable(target, canonical);
    await this.#writeImmutable(checksumTarget, sha256);

    return {
      sha256,
      relativePath: relative(root, target).replaceAll("\\", "/")
    };
  }

  async readAgentRunReceipt(runId: string): Promise<AgentRunReceipt> {
    const parsedRunId = StableIdSchema.parse(runId);
    const root = await this.#rootPath();
    const target = resolveWithinRoot(root, "agent-runs", `${parsedRunId}.json`);
    const checksumTarget = resolveWithinRoot(
      root,
      "agent-runs",
      `${parsedRunId}.sha256`
    );
    const realTarget = await realpath(target);
    const realChecksumTarget = await realpath(checksumTarget);
    this.#assertContained(realTarget);
    this.#assertContained(realChecksumTarget);

    const content = await readFile(realTarget, "utf8");
    const expectedSha256 = Sha256Schema.parse(
      await readFile(realChecksumTarget, "utf8")
    );
    if (sha256Hex(content) !== expectedSha256) {
      throw new Error(
        "agent run receipt failed its content-addressed integrity check"
      );
    }

    const receipt = AgentRunReceiptSchema.parse(JSON.parse(content) as unknown);
    if (receipt.runId !== parsedRunId) {
      throw new Error("agent run receipt failed its path identity integrity check");
    }

    const canonical = canonicalJson(receipt);
    if (sha256Hex(content) !== sha256Hex(canonical)) {
      throw new Error("agent run receipt failed its canonical integrity check");
    }

    return receipt;
  }

  async listAgentRunReceipts(
    limit = DEFAULT_AGENT_RUN_RECEIPT_LIMIT
  ): Promise<AgentRunReceipt[]> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_AGENT_RUN_RECEIPT_LIMIT
    ) {
      throw new Error(
        `agent run receipt limit must be an integer from 1 to ${MAX_AGENT_RUN_RECEIPT_LIMIT}`
      );
    }

    const root = await this.#rootPath();
    const directory = resolveWithinRoot(root, "agent-runs");
    let entries;
    try {
      const realDirectory = await realpath(directory);
      this.#assertContained(realDirectory);
      entries = await readdir(realDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const receipts: AgentRunReceipt[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const runId = entry.name.slice(0, -".json".length);
      if (!StableIdSchema.safeParse(runId).success) {
        continue;
      }

      try {
        receipts.push(await this.readAgentRunReceipt(runId));
      } catch {
        // Listing is a safe summary surface: malformed or tampered entries are omitted.
      }
    }

    return receipts
      .sort((first, second) => {
        const completionOrder =
          Date.parse(second.completedAt) - Date.parse(first.completedAt);
        if (completionOrder !== 0) {
          return completionOrder;
        }
        return second.runId.localeCompare(first.runId);
      })
      .slice(0, limit);
  }

  async putPortfolioRun(run: PortfolioRun): Promise<StoredObject> {
    const parsed = PortfolioRunSchema.parse(run);
    const runId = StableIdSchema.parse(parsed.runId);
    return this.#putChecksummedRecord(["portfolio-runs"], runId, parsed);
  }

  async readPortfolioRun(runId: string): Promise<PortfolioRun> {
    const parsedRunId = StableIdSchema.parse(runId);
    return this.#readChecksummedRecord(
      ["portfolio-runs"],
      parsedRunId,
      (value) => PortfolioRunSchema.parse(value),
      (run) => {
        if (run.runId !== parsedRunId) {
          throw new Error("portfolio run failed its path identity integrity check");
        }
      },
      "portfolio run"
    );
  }

  async listPortfolioRuns(
    limit = DEFAULT_PORTFOLIO_ARTIFACT_LIMIT
  ): Promise<PortfolioRun[]> {
    assertListLimit(limit, "portfolio run");
    const ids = await this.#listRecordIds(["portfolio-runs"], "portfolio run");
    const runs = await Promise.all(ids.map((runId) => this.readPortfolioRun(runId)));
    return runs
      .sort((first, second) => {
        const createdOrder =
          Date.parse(second.createdAt) - Date.parse(first.createdAt);
        return createdOrder !== 0
          ? createdOrder
          : second.runId.localeCompare(first.runId);
      })
      .slice(0, limit);
  }

  async putPortfolioRunCheckpoint(
    checkpoint: PortfolioRunCheckpoint
  ): Promise<StoredObject> {
    const parsed = PortfolioRunCheckpointSchema.parse(checkpoint);
    const runId = StableIdSchema.parse(parsed.runId);
    const checkpointId = StableIdSchema.parse(parsed.checkpointId);
    return this.#putChecksummedRecord(
      ["portfolio-run-checkpoints", runId],
      checkpointId,
      parsed
    );
  }

  async readPortfolioRunCheckpoint(
    runId: string,
    checkpointId: string
  ): Promise<PortfolioRunCheckpoint> {
    const parsedRunId = StableIdSchema.parse(runId);
    const parsedCheckpointId = StableIdSchema.parse(checkpointId);
    return this.#readChecksummedRecord(
      ["portfolio-run-checkpoints", parsedRunId],
      parsedCheckpointId,
      (value) => PortfolioRunCheckpointSchema.parse(value),
      (checkpoint) => {
        if (
          checkpoint.runId !== parsedRunId ||
          checkpoint.checkpointId !== parsedCheckpointId
        ) {
          throw new Error(
            "portfolio run checkpoint failed its path identity integrity check"
          );
        }
      },
      "portfolio run checkpoint"
    );
  }

  async listPortfolioRunCheckpoints(
    runId: string,
    limit = DEFAULT_PORTFOLIO_ARTIFACT_LIMIT
  ): Promise<PortfolioRunCheckpoint[]> {
    const parsedRunId = StableIdSchema.parse(runId);
    assertListLimit(limit, "portfolio run checkpoint");
    const ids = await this.#listRecordIds(
      ["portfolio-run-checkpoints", parsedRunId],
      "portfolio run checkpoint"
    );
    const checkpoints = await Promise.all(
      ids.map((checkpointId) =>
        this.readPortfolioRunCheckpoint(parsedRunId, checkpointId)
      )
    );
    return checkpoints
      .sort((first, second) => {
        const sequenceOrder = first.sequence - second.sequence;
        return sequenceOrder !== 0
          ? sequenceOrder
          : first.checkpointId.localeCompare(second.checkpointId);
      })
      .slice(0, limit);
  }

  async putRecommendationDecisionEvent(
    event: RecommendationDecisionEvent
  ): Promise<StoredObject> {
    const parsed = RecommendationDecisionEventSchema.parse(event);
    const eventId = StableIdSchema.parse(parsed.eventId);
    return this.#putChecksummedRecord(
      ["recommendation-decision-events"],
      eventId,
      parsed
    );
  }

  async readRecommendationDecisionEvent(
    eventId: string
  ): Promise<RecommendationDecisionEvent> {
    const parsedEventId = StableIdSchema.parse(eventId);
    return this.#readChecksummedRecord(
      ["recommendation-decision-events"],
      parsedEventId,
      (value) => RecommendationDecisionEventSchema.parse(value),
      (event) => {
        if (event.eventId !== parsedEventId) {
          throw new Error(
            "recommendation decision event failed its path identity integrity check"
          );
        }
      },
      "recommendation decision event"
    );
  }

  async listRecommendationDecisionEvents(
    limit = DEFAULT_PORTFOLIO_ARTIFACT_LIMIT,
    recommendationIds?: readonly string[]
  ): Promise<RecommendationDecisionEvent[]> {
    assertListLimit(limit, "recommendation decision event");
    const ids = await this.#listRecordIds(
      ["recommendation-decision-events"],
      "recommendation decision event"
    );
    const compareEvents = (
      first: RecommendationDecisionEvent,
      second: RecommendationDecisionEvent
    ): number => {
      const occurredOrder =
        Date.parse(first.occurredAt) - Date.parse(second.occurredAt);
      if (occurredOrder !== 0) {
        return occurredOrder;
      }
      const sequenceOrder = first.sequence - second.sequence;
      return sequenceOrder !== 0
        ? sequenceOrder
        : first.eventId.localeCompare(second.eventId);
    };
    const compareDecisionOrder = (
      first: RecommendationDecisionEvent,
      second: RecommendationDecisionEvent
    ): number =>
      first.sequence - second.sequence ||
      first.eventId.localeCompare(second.eventId);
    const retainNewest = (
      retained: RecommendationDecisionEvent[],
      event: RecommendationDecisionEvent,
      compare: (
        first: RecommendationDecisionEvent,
        second: RecommendationDecisionEvent
      ) => number
    ): void => {
      retained.push(event);
      retained.sort((first, second) => compare(second, first));
      if (retained.length > limit) {
        retained.length = limit;
      }
    };

    if (recommendationIds === undefined) {
      const newest: RecommendationDecisionEvent[] = [];
      for (const eventId of ids) {
        retainNewest(
          newest,
          await this.readRecommendationDecisionEvent(eventId),
          compareEvents
        );
      }
      return newest.sort(compareEvents);
    }

    const parsedRecommendationIds = recommendationIds.map((recommendationId) =>
      StableIdSchema.parse(recommendationId)
    );
    if (
      parsedRecommendationIds.length > limit ||
      new Set(parsedRecommendationIds).size !== parsedRecommendationIds.length
    ) {
      throw new Error(
        "recommendation decision event recovery IDs must be unique and cannot exceed the limit"
      );
    }
    if (parsedRecommendationIds.length === 0) {
      return [];
    }
    const requestedRecommendationIds = new Set(parsedRecommendationIds);
    const latestByRecommendation = new Map<
      string,
      RecommendationDecisionEvent
    >();
    const newestCandidates: RecommendationDecisionEvent[] = [];
    for (const eventId of ids) {
      const event = await this.readRecommendationDecisionEvent(eventId);
      if (!requestedRecommendationIds.has(event.recommendationId)) {
        continue;
      }
      const latest = latestByRecommendation.get(event.recommendationId);
      if (latest === undefined || compareDecisionOrder(event, latest) > 0) {
        latestByRecommendation.set(event.recommendationId, event);
      }
      retainNewest(newestCandidates, event, compareDecisionOrder);
    }

    const selected = [...latestByRecommendation.values()];
    const selectedIds = new Set(selected.map((event) => event.eventId));
    selected.push(
      ...newestCandidates
        .filter((event) => !selectedIds.has(event.eventId))
        .slice(0, limit - selected.length)
    );
    return selected.sort(compareEvents);
  }

  async putDashboardTemplateEvent(
    event: DashboardTemplateEvent
  ): Promise<StoredObject> {
    const parsed = DashboardTemplateEventSchema.parse(event);
    const templateId = StableIdSchema.parse(parsed.templateId);
    const eventId = StableIdSchema.parse(parsed.eventId);
    return this.#putChecksummedRecord(
      ["dashboard-templates", templateId, "events"],
      eventId,
      parsed
    );
  }

  async listDashboardTemplateIds(): Promise<string[]> {
    const root = await this.#rootPath();
    const directory = resolveWithinRoot(root, "dashboard-templates");
    let stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        "dashboard template directory cannot be a symbolic link, junction, or file"
      );
    }
    const realDirectory = await realpath(directory);
    this.#assertContained(realDirectory);
    const entries = await readdir(realDirectory, { withFileTypes: true });
    const templateIds: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          "dashboard template directory cannot contain a symbolic link or junction"
        );
      }
      if (!entry.isDirectory()) {
        throw new Error("dashboard template directory contains an unexpected file");
      }
      if (!StableIdSchema.safeParse(entry.name).success) {
        throw new Error("dashboard template directory contains an invalid identifier");
      }
      templateIds.push(entry.name);
    }
    return templateIds.sort((left, right) => left.localeCompare(right));
  }

  async readDashboardTemplateEvent(
    templateId: string,
    eventId: string
  ): Promise<DashboardTemplateEvent> {
    const parsedTemplateId = StableIdSchema.parse(templateId);
    const parsedEventId = StableIdSchema.parse(eventId);
    return this.#readChecksummedRecord(
      ["dashboard-templates", parsedTemplateId, "events"],
      parsedEventId,
      (value) => DashboardTemplateEventSchema.parse(value),
      (event) => {
        if (
          event.templateId !== parsedTemplateId ||
          event.eventId !== parsedEventId
        ) {
          throw new Error(
            "dashboard template event failed its path identity integrity check"
          );
        }
      },
      "dashboard template event"
    );
  }

  async listDashboardTemplateEvents(
    templateId: string
  ): Promise<DashboardTemplateEvent[]> {
    const parsedTemplateId = StableIdSchema.parse(templateId);
    const ids = await this.#listStrictRecordIds(
      ["dashboard-templates", parsedTemplateId, "events"],
      "dashboard template event"
    );
    const events = await Promise.all(
      ids.map((eventId) =>
        this.readDashboardTemplateEvent(parsedTemplateId, eventId)
      )
    );
    return events.sort((left, right) => {
      const sequenceOrder = left.sequence - right.sequence;
      return sequenceOrder !== 0
        ? sequenceOrder
        : left.eventId.localeCompare(right.eventId);
    });
  }

  async putDashboardBuildReceipt(
    receipt: DashboardBuildReceipt
  ): Promise<StoredObject> {
    const parsed = DashboardBuildReceiptSchema.parse(receipt);
    return this.#putChecksummedRecord(
      ["dashboard-builds"],
      StableIdSchema.parse(parsed.buildId),
      parsed
    );
  }

  async readDashboardBuildReceipt(
    buildId: string
  ): Promise<DashboardBuildReceipt> {
    const parsedBuildId = StableIdSchema.parse(buildId);
    return this.#readChecksummedRecord(
      ["dashboard-builds"],
      parsedBuildId,
      (value) => DashboardBuildReceiptSchema.parse(value),
      (receipt) => {
        if (receipt.buildId !== parsedBuildId) {
          throw new Error(
            "dashboard build receipt failed its path identity integrity check"
          );
        }
      },
      "dashboard build receipt"
    );
  }

  async listDashboardBuildReceipts(
    templateId?: string
  ): Promise<DashboardBuildReceipt[]> {
    const parsedTemplateId =
      templateId === undefined ? undefined : StableIdSchema.parse(templateId);
    const ids = await this.#listStrictRecordIds(
      ["dashboard-builds"],
      "dashboard build receipt"
    );
    const receipts = await Promise.all(
      ids.map((buildId) => this.readDashboardBuildReceipt(buildId))
    );
    return receipts
      .filter(
        (receipt) =>
          parsedTemplateId === undefined ||
          receipt.templateId === parsedTemplateId
      )
      .sort((left, right) => {
        const completedOrder =
          Date.parse(left.completedAt) - Date.parse(right.completedAt);
        return completedOrder !== 0
          ? completedOrder
          : left.buildId.localeCompare(right.buildId);
      });
  }

  async putDashboardImportReceipt(
    receipt: DashboardImportReceipt
  ): Promise<StoredObject> {
    const parsed = DashboardImportReceiptSchema.parse(receipt);
    return this.#putChecksummedRecord(
      ["dashboard-imports"],
      StableIdSchema.parse(parsed.importId),
      parsed
    );
  }

  async readDashboardImportReceipt(
    importId: string
  ): Promise<DashboardImportReceipt> {
    const parsedImportId = StableIdSchema.parse(importId);
    return this.#readChecksummedRecord(
      ["dashboard-imports"],
      parsedImportId,
      (value) => DashboardImportReceiptSchema.parse(value),
      (receipt) => {
        if (receipt.importId !== parsedImportId) {
          throw new Error(
            "dashboard import receipt failed its path identity integrity check"
          );
        }
      },
      "dashboard import receipt"
    );
  }

  async listDashboardImportReceipts(
    templateId?: string
  ): Promise<DashboardImportReceipt[]> {
    const parsedTemplateId =
      templateId === undefined ? undefined : StableIdSchema.parse(templateId);
    const ids = await this.#listStrictRecordIds(
      ["dashboard-imports"],
      "dashboard import receipt"
    );
    const receipts = await Promise.all(
      ids.map((importId) => this.readDashboardImportReceipt(importId))
    );
    return receipts
      .filter(
        (receipt) =>
          parsedTemplateId === undefined ||
          receipt.templateId === parsedTemplateId
      )
      .sort((left, right) => {
        const occurredOrder =
          Date.parse(left.occurredAt) - Date.parse(right.occurredAt);
        return occurredOrder !== 0
          ? occurredOrder
          : left.importId.localeCompare(right.importId);
      });
  }

  async #rootPath(): Promise<string> {
    await this.initialize();
    return this.#realRoot as string;
  }

  #hasSameIdentity(
    expected: DirectoryIdentity | undefined,
    actual: DirectoryIdentity
  ): boolean {
    return (
      expected !== undefined &&
      expected.dev === actual.dev &&
      expected.ino === actual.ino
    );
  }

  async #objectPath(sha256: string): Promise<string> {
    const root = await this.#rootPath();
    return resolveWithinRoot(root, "objects", sha256.slice(0, 2), `${sha256}.json`);
  }

  #assertContained(candidate: string): void {
    if (this.#realRoot === undefined || !isContained(this.#realRoot, candidate)) {
      throw new Error("resolved evidence path escapes the configured local root");
    }
  }

  async #putChecksummedRecord(
    directorySegments: readonly string[],
    id: string,
    value: unknown
  ): Promise<StoredObject> {
    const canonical = canonicalJson(value);
    const sha256 = sha256Hex(canonical);
    const root = await this.#rootPath();
    const target = resolveWithinRoot(
      root,
      ...directorySegments,
      `${id}.json`
    );
    const checksumTarget = resolveWithinRoot(
      root,
      ...directorySegments,
      `${id}.sha256`
    );

    await this.#writeImmutable(target, canonical);
    await this.#writeImmutable(checksumTarget, sha256);

    return {
      sha256,
      relativePath: relative(root, target).replaceAll("\\", "/")
    };
  }

  async #readChecksummedRecord<T>(
    directorySegments: readonly string[],
    id: string,
    parse: (value: unknown) => T,
    assertIdentity: (value: T) => void,
    label: string
  ): Promise<T> {
    const root = await this.#rootPath();
    const target = resolveWithinRoot(
      root,
      ...directorySegments,
      `${id}.json`
    );
    const checksumTarget = resolveWithinRoot(
      root,
      ...directorySegments,
      `${id}.sha256`
    );
    const content = await this.#readImmutableFile(target, label);
    const expectedSha256 = Sha256Schema.parse(
      await this.#readImmutableFile(checksumTarget, `${label} checksum`)
    );
    if (sha256Hex(content) !== expectedSha256) {
      throw new Error(`${label} failed its content-addressed integrity check`);
    }

    const parsed = parse(JSON.parse(content) as unknown);
    assertIdentity(parsed);
    if (content !== canonicalJson(parsed)) {
      throw new Error(`${label} failed its canonical integrity check`);
    }
    return parsed;
  }

  async #listRecordIds(
    directorySegments: readonly string[],
    label: string
  ): Promise<string[]> {
    const root = await this.#rootPath();
    const directory = resolveWithinRoot(root, ...directorySegments);
    let stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} directory cannot be a symbolic link or junction`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`${label} path must be a directory`);
    }
    const realDirectory = await realpath(directory);
    this.#assertContained(realDirectory);
    const entries = await readdir(realDirectory, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`${label} cannot be a symbolic link or junction`);
      }
      if (!entry.isFile()) {
        continue;
      }
      const id = entry.name.slice(0, -".json".length);
      if (StableIdSchema.safeParse(id).success) {
        ids.push(id);
      }
    }
    return ids;
  }

  async #listStrictRecordIds(
    directorySegments: readonly string[],
    label: string
  ): Promise<string[]> {
    const root = await this.#rootPath();
    const directory = resolveWithinRoot(root, ...directorySegments);
    let stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} directory cannot be a symbolic link or junction`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`${label} path must be a directory`);
    }
    const realDirectory = await realpath(directory);
    this.#assertContained(realDirectory);
    const entries = await readdir(realDirectory, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(`${label} cannot be a symbolic link or junction`);
      }
      if (!entry.name.endsWith(".json")) {
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`${label} must be a regular file`);
      }
      const id = entry.name.slice(0, -".json".length);
      if (!StableIdSchema.safeParse(id).success) {
        throw new Error(`${label} history contains an invalid record identifier`);
      }
      ids.push(id);
    }
    return ids;
  }

  async #readImmutableFile(target: string, label: string): Promise<string> {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} cannot be a symbolic link or junction`);
    }
    if (!stats.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    const realTarget = await realpath(target);
    this.#assertContained(realTarget);
    return readFile(realTarget, "utf8");
  }

  async #readExistingImmutableFile(target: string): Promise<string | undefined> {
    let stats;
    try {
      stats = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        "an immutable evidence target cannot be a symbolic link or junction"
      );
    }
    if (!stats.isFile()) {
      throw new Error("an immutable evidence target must be a regular file");
    }
    const realTarget = await realpath(target);
    this.#assertContained(realTarget);
    return readFile(realTarget, "utf8");
  }

  async #writeImmutable(target: string, content: string): Promise<void> {
    const parent = dirname(target);
    const realParent = await this.#ensureContainedDirectory(parent);
    const safeTarget = resolveWithinRoot(realParent, basename(target));

    const existingBeforeWrite = await this.#readExistingImmutableFile(safeTarget);
    if (existingBeforeWrite !== undefined) {
      const existing = existingBeforeWrite;
      if (existing !== content) {
        throw new Error("immutable evidence path already contains different content");
      }
      return;
    }

    const temporary = resolveWithinRoot(
      realParent,
      `.${randomUUID()}.temporary-evidence`
    );

    await writeFile(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });

    try {
      await link(temporary, safeTarget);
    } catch (error) {
      const existing = await this.#readExistingImmutableFile(safeTarget);
      if (existing === content) {
        return;
      }
      if (existing !== undefined) {
        throw new Error("immutable evidence path already contains different content");
      }
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #ensureContainedDirectory(target: string): Promise<string> {
    const root = await this.#rootPath();
    const pathFromRoot = relative(root, target);

    if (
      pathFromRoot.startsWith(`..${sep}`) ||
      pathFromRoot === ".." ||
      isAbsolute(pathFromRoot)
    ) {
      throw new Error("evidence directory escapes the configured local root");
    }

    let current = root;
    for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
      const candidate = resolveWithinRoot(current, segment);
      try {
        await mkdir(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }

      const candidateStats = await lstat(candidate);
      if (candidateStats.isSymbolicLink()) {
        throw new Error(
          "an evidence directory cannot be a symbolic link or junction"
        );
      }
      if (!candidateStats.isDirectory()) {
        throw new Error("every evidence path component must be a directory");
      }

      current = await realpath(candidate);
      this.#assertContained(current);
    }

    return current;
  }
}
