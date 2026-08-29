import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_BRANCH = "feature/portfolio-rationalization";
const REQUIRED_OLLAMA_MODEL = "qwen3:4b";
const EXPECTED_LIVE_SOURCE_COUNT = 23;
const REPORT_SCHEMA_VERSION = "portfolio-live-acceptance/v1";

export interface PortfolioAcceptanceRepository {
  repositoryId: string;
  fullName: string;
  recommendationAction: string | undefined;
  citations: unknown[];
}

export interface PortfolioAcceptanceCluster {
  clusterId: string;
  repositoryIds: string[];
  citationIds: string[];
}

export interface PortfolioAcceptanceDecisionEvent {
  eventId: string;
  recommendationId: string;
  runId: string;
  sequence: number;
}

export interface PortfolioAcceptanceRecommendation {
  recommendationId: string;
  repositoryIds: string[];
  citationIds: string[];
  rationale?: string;
  decisionHistory: PortfolioAcceptanceDecisionEvent[];
}

export interface PortfolioAcceptanceObservation {
  expectedBranch: string;
  actualBranch: string;
  expectedSourceCount: number;
  observedAt: string;
  ollama: {
    pinnedModel: string;
    pinnedModelAvailable: boolean;
    inventoryCount: number;
  };
  run: {
    runId: string;
    status: string;
    createdAt: string;
    completedAt: string | undefined;
    repositoryCount: number;
    warningCount: number;
    revisionMismatchCount: number;
  };
  repositories: PortfolioAcceptanceRepository[];
  clusters: PortfolioAcceptanceCluster[];
  recommendations: PortfolioAcceptanceRecommendation[];
}

export type PortfolioAcceptanceFailureCode =
  | "branch-mismatch"
  | "ollama-model-unavailable"
  | "run-not-succeeded"
  | "run-completion-invalid"
  | "source-count-mismatch"
  | "summary-count-mismatch"
  | "source-identity-invalid"
  | "revision-mismatch"
  | "recommendation-count-mismatch"
  | "recommendation-coverage-incomplete"
  | "source-citations-missing"
  | "recommendation-citations-missing"
  | "cluster-citations-missing"
  | "cluster-membership-invalid"
  | "portfolio-coverage-incomplete"
  | "decision-history-invalid";

export interface PortfolioAcceptanceCheck {
  code: PortfolioAcceptanceFailureCode;
  passed: boolean;
}

export interface PortfolioAcceptanceFailure {
  code: PortfolioAcceptanceFailureCode;
  message: string;
}

export interface SanitizedPortfolioAcceptanceReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  accepted: boolean;
  observedAt: string;
  branch: string;
  ollama: {
    pinnedModel: string;
    pinnedModelAvailable: boolean;
    inventoryCount: number;
  };
  run: {
    fingerprintSha256: string;
    status: string;
    createdAt: string;
    completedAt: string | undefined;
    repositoryCount: number;
    warningCount: number;
    revisionMismatchCount: number;
  };
  coverage: {
    expectedSourceCount: number;
    sourceProjectionCount: number;
    recommendationCount: number;
    recommendationCoverageCount: number;
    clusteredSourceCount: number;
    standaloneSourceCount: number;
    citationBearingSourceCount: number;
    citationBearingRecommendationCount: number;
    decisionHistoryBearingRecommendationCount: number;
    decisionEventCount: number;
  };
  checks: PortfolioAcceptanceCheck[];
  failures: PortfolioAcceptanceFailure[];
}

const SAFE_FAILURE_MESSAGES: Record<PortfolioAcceptanceFailureCode, string> = {
  "branch-mismatch": "The exact acceptance branch was not active.",
  "ollama-model-unavailable": "The pinned local Ollama model was not available.",
  "run-not-succeeded": "The portfolio run did not succeed.",
  "run-completion-invalid": "The completed run identity or timestamp was invalid.",
  "source-count-mismatch": "The expected source projection count was not met.",
  "summary-count-mismatch": "The run summary and source projections disagreed.",
  "source-identity-invalid": "Source projection identities were incomplete or duplicated.",
  "revision-mismatch": "At least one source revision moved during capture.",
  "recommendation-count-mismatch": "There was not exactly one recommendation per source.",
  "recommendation-coverage-incomplete": "Recommendation subject coverage was incomplete or duplicated.",
  "source-citations-missing": "At least one source projection had no citation.",
  "recommendation-citations-missing": "At least one recommendation had no citation.",
  "cluster-citations-missing": "At least one overlap cluster had no citation.",
  "cluster-membership-invalid": "Cluster membership was empty, duplicated, or referenced an unknown source.",
  "portfolio-coverage-incomplete": "At least one source was neither clustered nor derived as standalone.",
  "decision-history-invalid": "At least one recommendation lacked a contiguous append-only decision history."
};

class LiveAcceptanceFailure extends Error {
  readonly safeMessage: string;

  constructor(safeMessage: string) {
    super(safeMessage);
    this.name = "LiveAcceptanceFailure";
    this.safeMessage = safeMessage;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function validTimestamp(value: string | undefined): boolean {
  return nonEmpty(value) && Number.isFinite(Date.parse(value!));
}

function appendOnlyHistoryIsValid(
  recommendation: PortfolioAcceptanceRecommendation,
  runId: string
): boolean {
  if (recommendation.decisionHistory.length === 0) {
    return false;
  }
  const eventIds = new Set<string>();
  return recommendation.decisionHistory.every((event, index) => {
    const valid =
      nonEmpty(event.eventId) &&
      event.recommendationId === recommendation.recommendationId &&
      event.runId === runId &&
      event.sequence === index &&
      !eventIds.has(event.eventId);
    eventIds.add(event.eventId);
    return valid;
  });
}

export function buildSanitizedAcceptanceReport(
  observation: PortfolioAcceptanceObservation
): SanitizedPortfolioAcceptanceReport {
  const checks: PortfolioAcceptanceCheck[] = [];
  const failures: PortfolioAcceptanceFailure[] = [];
  const check = (
    code: PortfolioAcceptanceFailureCode,
    passed: boolean
  ): void => {
    checks.push({ code, passed });
    if (!passed) {
      failures.push({ code, message: SAFE_FAILURE_MESSAGES[code] });
    }
  };

  const sourceIds = observation.repositories.map(
    (repository) => repository.repositoryId
  );
  const uniqueSourceIds = new Set(sourceIds);
  const sourceIdentityIsValid =
    sourceIds.length === uniqueSourceIds.size && sourceIds.every(nonEmpty);
  const recommendationIds = observation.recommendations.map(
    (recommendation) => recommendation.recommendationId
  );
  const recommendationSubjects = observation.recommendations.map(
    (recommendation) => recommendation.repositoryIds[0]
  );
  const knownRecommendationSubjects = recommendationSubjects.filter(
    (repositoryId): repositoryId is string =>
      repositoryId !== undefined && uniqueSourceIds.has(repositoryId)
  );
  const recommendationSubjectSet = new Set(knownRecommendationSubjects);
  const recommendationCoverageCount = observation.repositories.filter(
    (repository) => nonEmpty(repository.recommendationAction)
  ).length;

  const clusteredSourceIds = new Set<string>();
  let clusterMembershipIsValid = true;
  for (const cluster of observation.clusters) {
    const localIds = new Set(cluster.repositoryIds);
    if (
      !nonEmpty(cluster.clusterId) ||
      cluster.repositoryIds.length < 2 ||
      localIds.size !== cluster.repositoryIds.length
    ) {
      clusterMembershipIsValid = false;
    }
    for (const repositoryId of cluster.repositoryIds) {
      if (
        !uniqueSourceIds.has(repositoryId) ||
        clusteredSourceIds.has(repositoryId)
      ) {
        clusterMembershipIsValid = false;
      } else {
        clusteredSourceIds.add(repositoryId);
      }
    }
  }
  const standaloneSourceIds = [...uniqueSourceIds].filter(
    (repositoryId) => !clusteredSourceIds.has(repositoryId)
  );
  const portfolioCoverageCount =
    clusteredSourceIds.size + standaloneSourceIds.length;

  const citationBearingSourceCount = observation.repositories.filter(
    (repository) => repository.citations.length > 0
  ).length;
  const citationBearingRecommendationCount = observation.recommendations.filter(
    (recommendation) => recommendation.citationIds.length > 0
  ).length;
  const validDecisionHistories = observation.recommendations.filter(
    (recommendation) =>
      appendOnlyHistoryIsValid(recommendation, observation.run.runId)
  );

  check(
    "branch-mismatch",
    observation.actualBranch === observation.expectedBranch &&
      observation.expectedBranch === REQUIRED_BRANCH
  );
  check(
    "ollama-model-unavailable",
    observation.ollama.pinnedModel === REQUIRED_OLLAMA_MODEL &&
      observation.ollama.pinnedModelAvailable
  );
  check("run-not-succeeded", observation.run.status === "succeeded");
  check(
    "run-completion-invalid",
    nonEmpty(observation.run.runId) &&
      validTimestamp(observation.run.createdAt) &&
      validTimestamp(observation.run.completedAt)
  );
  check(
    "source-count-mismatch",
    observation.expectedSourceCount > 0 &&
      observation.repositories.length === observation.expectedSourceCount
  );
  check(
    "summary-count-mismatch",
    observation.run.repositoryCount === observation.repositories.length
  );
  check("source-identity-invalid", sourceIdentityIsValid);
  check("revision-mismatch", observation.run.revisionMismatchCount === 0);
  check(
    "recommendation-count-mismatch",
    observation.recommendations.length === observation.expectedSourceCount &&
      new Set(recommendationIds).size === recommendationIds.length &&
      recommendationIds.every(nonEmpty)
  );
  check(
    "recommendation-coverage-incomplete",
    recommendationCoverageCount === observation.expectedSourceCount &&
      knownRecommendationSubjects.length === observation.recommendations.length &&
      recommendationSubjectSet.size === observation.expectedSourceCount &&
      observation.recommendations.every((recommendation) =>
        recommendation.repositoryIds.every((repositoryId) =>
          uniqueSourceIds.has(repositoryId)
        )
      )
  );
  check(
    "source-citations-missing",
    citationBearingSourceCount === observation.expectedSourceCount
  );
  check(
    "recommendation-citations-missing",
    citationBearingRecommendationCount === observation.expectedSourceCount
  );
  check(
    "cluster-citations-missing",
    observation.clusters.every((cluster) => cluster.citationIds.length > 0)
  );
  check("cluster-membership-invalid", clusterMembershipIsValid);
  check(
    "portfolio-coverage-incomplete",
    sourceIdentityIsValid &&
      portfolioCoverageCount === observation.expectedSourceCount
  );
  check(
    "decision-history-invalid",
    validDecisionHistories.length === observation.expectedSourceCount
  );

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    accepted: failures.length === 0,
    observedAt: observation.observedAt,
    branch: observation.expectedBranch,
    ollama: {
      pinnedModel: REQUIRED_OLLAMA_MODEL,
      pinnedModelAvailable: observation.ollama.pinnedModelAvailable,
      inventoryCount: observation.ollama.inventoryCount
    },
    run: {
      fingerprintSha256: sha256(observation.run.runId),
      status: observation.run.status,
      createdAt: observation.run.createdAt,
      completedAt: observation.run.completedAt,
      repositoryCount: observation.run.repositoryCount,
      warningCount: observation.run.warningCount,
      revisionMismatchCount: observation.run.revisionMismatchCount
    },
    coverage: {
      expectedSourceCount: observation.expectedSourceCount,
      sourceProjectionCount: observation.repositories.length,
      recommendationCount: observation.recommendations.length,
      recommendationCoverageCount,
      clusteredSourceCount: clusteredSourceIds.size,
      standaloneSourceCount: standaloneSourceIds.length,
      citationBearingSourceCount,
      citationBearingRecommendationCount,
      decisionHistoryBearingRecommendationCount: validDecisionHistories.length,
      decisionEventCount: observation.recommendations.reduce(
        (count, recommendation) => count + recommendation.decisionHistory.length,
        0
      )
    },
    checks,
    failures
  };
}

export function serializeSanitizedReport(
  report: SanitizedPortfolioAcceptanceReport,
  secretValues: readonly string[] = []
): string {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const secrets = secretValues.map((value) => value.trim()).filter(nonEmpty);
  const containsCredential = secrets.some((secret) =>
    serialized.includes(secret)
  );
  const containsCredentialPattern =
    /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_=-]{8,}\b/iu.test(serialized) ||
    /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/iu.test(serialized);
  const containsRawField =
    /"(?:fullName|locator|statement|rationale|citations|decisionHistory|warnings|models|token|authorization)"\s*:/iu.test(
      serialized
    );
  if (containsCredential || containsCredentialPattern || containsRawField) {
    throw new LiveAcceptanceFailure("sanitized output safety check failed.");
  }
  return serialized;
}

export function formatSecretSafeFailure(error: unknown): string {
  if (error instanceof LiveAcceptanceFailure) {
    return `Portfolio live acceptance failed: ${error.safeMessage}`;
  }
  return "Portfolio live acceptance failed before a sanitized result was available.";
}

function repositoryRootFromScript(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function readCurrentBranch(repositoryRoot: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 4_096
    }).trim();
  } catch {
    throw new LiveAcceptanceFailure("the current Git branch could not be read safely.");
  }
}

function configuredCredentialValues(): string[] {
  const selected =
    process.env["GITHUB_TOKEN"]?.trim() ?? process.env["GH_TOKEN"]?.trim();
  if (!nonEmpty(selected)) {
    throw new LiveAcceptanceFailure(
      "an existing GITHUB_TOKEN or GH_TOKEN is required in the ignored .env file."
    );
  }
  return [
    process.env["GITHUB_TOKEN"]?.trim(),
    process.env["GH_TOKEN"]?.trim()
  ].filter((value): value is string => nonEmpty(value));
}

async function writeSanitizedReport(
  repositoryRoot: string,
  report: SanitizedPortfolioAcceptanceReport,
  secretValues: readonly string[]
): Promise<string> {
  const acceptanceRoot = resolve(repositoryRoot, ".local", "acceptance");
  const expectedRelativeRoot = [".local", "acceptance"].join("/");
  const actualRelativeRoot = relative(repositoryRoot, acceptanceRoot).replaceAll(
    "\\",
    "/"
  );
  if (actualRelativeRoot !== expectedRelativeRoot) {
    throw new LiveAcceptanceFailure("the sanitized report path failed its boundary check.");
  }
  const safeTimestamp = report.observedAt.replace(/[^0-9A-Za-z]/gu, "");
  const reportPath = resolve(
    acceptanceRoot,
    `portfolio-live-acceptance-${safeTimestamp}.json`
  );
  if (dirname(reportPath) !== acceptanceRoot) {
    throw new LiveAcceptanceFailure("the sanitized report path failed its boundary check.");
  }
  const serialized = serializeSanitizedReport(report, secretValues);
  try {
    await mkdir(acceptanceRoot, { recursive: true });
    await writeFile(reportPath, serialized, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error instanceof LiveAcceptanceFailure) {
      throw error;
    }
    throw new LiveAcceptanceFailure("the sanitized report could not be written.");
  }
  return relative(repositoryRoot, reportPath).replaceAll("\\", "/");
}

async function runLiveAcceptance(arguments_: readonly string[]): Promise<void> {
  if (arguments_.length !== 1 || arguments_[0] !== "--live") {
    throw new LiveAcceptanceFailure(
      "explicit --live opt-in is required; no live request was made."
    );
  }

  const repositoryRoot = repositoryRootFromScript();
  const actualBranch = readCurrentBranch(repositoryRoot);
  if (actualBranch !== REQUIRED_BRANCH) {
    throw new LiveAcceptanceFailure(
      `the exact ${REQUIRED_BRANCH} branch is required; no live request was made.`
    );
  }

  const [{ createServices }, configModule] = await Promise.all([
    import("../apps/api/src/composition.js"),
    import("../apps/api/src/config.js")
  ]);
  let environmentLoaded = false;
  try {
    environmentLoaded = configModule.loadOptionalEnvironmentFile(repositoryRoot);
  } catch {
    throw new LiveAcceptanceFailure("the ignored .env file could not be loaded safely.");
  }
  if (!environmentLoaded) {
    throw new LiveAcceptanceFailure("the ignored .env file is required for live acceptance.");
  }
  const secretValues = configuredCredentialValues();

  let services: Awaited<ReturnType<typeof createServices>>;
  try {
    const config = configModule.readConfig(process.env, repositoryRoot);
    services = await createServices(config);
  } catch {
    throw new LiveAcceptanceFailure("API service composition failed safely.");
  }

  let inventory: Awaited<ReturnType<typeof services.ollama.probeModelInventory>>;
  try {
    inventory = await services.ollama.probeModelInventory();
  } catch {
    throw new LiveAcceptanceFailure("the read-only Ollama inventory probe failed.");
  }
  if (
    inventory.pinnedModel !== REQUIRED_OLLAMA_MODEL ||
    !inventory.pinnedModelAvailable
  ) {
    throw new LiveAcceptanceFailure(
      `the existing ${REQUIRED_OLLAMA_MODEL} model is required; the inventory was not changed.`
    );
  }

  let queued: ReturnType<typeof services.portfolio.startRun>;
  try {
    queued = services.portfolio.startRun();
  } catch {
    throw new LiveAcceptanceFailure("exactly one portfolio run could not be started.");
  }

  let completed: Awaited<ReturnType<typeof services.portfolio.waitForRun>>;
  try {
    completed = await services.portfolio.waitForRun(queued.runId);
  } catch {
    throw new LiveAcceptanceFailure("the started portfolio run could not be awaited safely.");
  }

  const repositories =
    completed.status === "succeeded"
      ? services.portfolio.listRepositories().map((repository) => ({
          repositoryId: repository.repositoryId,
          fullName: repository.fullName,
          recommendationAction: repository.recommendationAction,
          citations: repository.citations
        }))
      : [];
  const clusters =
    completed.status === "succeeded"
      ? services.portfolio.listClusters().map((cluster) => ({
          clusterId: cluster.clusterId,
          repositoryIds: cluster.repositoryIds,
          citationIds: cluster.citationIds
        }))
      : [];
  const recommendations =
    completed.status === "succeeded"
      ? services.portfolio.listRecommendations().map((recommendation) => ({
          recommendationId: recommendation.recommendationId,
          repositoryIds: recommendation.repositoryIds,
          citationIds: recommendation.citationIds,
          decisionHistory: recommendation.decisionHistory.map((event) => ({
            eventId: event.eventId,
            recommendationId: event.recommendationId,
            runId: event.runId,
            sequence: event.sequence
          }))
        }))
      : [];

  const report = buildSanitizedAcceptanceReport({
    expectedBranch: REQUIRED_BRANCH,
    actualBranch,
    expectedSourceCount: EXPECTED_LIVE_SOURCE_COUNT,
    observedAt: new Date().toISOString(),
    ollama: {
      pinnedModel: inventory.pinnedModel,
      pinnedModelAvailable: inventory.pinnedModelAvailable,
      inventoryCount: inventory.models.length
    },
    run: {
      runId: completed.runId,
      status: completed.status,
      createdAt: completed.createdAt,
      completedAt: completed.completedAt,
      repositoryCount: completed.repositoryCount,
      warningCount: completed.warningCount,
      revisionMismatchCount: completed.revisionMismatchCount
    },
    repositories,
    clusters,
    recommendations
  });
  const reportPath = await writeSanitizedReport(
    repositoryRoot,
    report,
    secretValues
  );
  process.stdout.write(
    `Portfolio live acceptance ${report.accepted ? "passed" : "failed"}; sanitized report: ${reportPath}\n`
  );
  if (!report.accepted) {
    throw new LiveAcceptanceFailure(
      "sanitized validation checks did not pass; inspect only the sanitized report."
    );
  }
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  pathToFileURL(resolve(entry)).href === import.meta.url
) {
  void runLiveAcceptance(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${formatSecretSafeFailure(error)}\n`);
    process.exitCode = 1;
  });
}
