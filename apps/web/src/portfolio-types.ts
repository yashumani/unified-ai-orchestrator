export const PORTFOLIO_RECOMMENDATION_ACTIONS = [
  "keep-standalone",
  "combine-with-peer",
  "extract-shared-component",
  "adopt-capability-into-orchestrator",
  "archive-candidate",
  "defer-insufficient-evidence"
] as const;

export type PortfolioRecommendationAction =
  (typeof PORTFOLIO_RECOMMENDATION_ACTIONS)[number];

export type PortfolioRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "completed"
  | "incomplete"
  | "degraded"
  | "paused"
  | "failed"
  | "cancelled"
  | "deferred";

export interface PortfolioRun {
  runId: string;
  status: PortfolioRunStatus;
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

export interface PortfolioCitation {
  citationId: string;
  family: string;
  locator: string;
  statement: string;
}

export interface PortfolioRepository {
  repositoryId: string;
  fullName: string;
  visibility: "public" | "private" | "internal" | "unknown" | "unavailable";
  purpose: string;
  capabilities: string[];
  technologyTags: string[];
  evidenceCoverage: number;
  chatCoverage: number;
  contradictions: string[];
  citations: PortfolioCitation[];
  capturedRevision: string;
  recommendationAction?: PortfolioRecommendationAction;
}

export interface PortfolioCluster {
  clusterId: string;
  label: string;
  rationale: string;
  sharedCapabilities: string[];
  repositoryIds: string[];
  citationIds: string[];
}

export type PortfolioRecommendationLifecycle =
  | "draft"
  | "auto-finalized"
  | "overridden"
  | "deferred";

export const PORTFOLIO_OVERRIDE_REASON_CODES = [
  "incorrect-evidence",
  "missing-context",
  "strategic-priority",
  "risk-tolerance",
  "other"
] as const;

export type PortfolioOverrideReasonCode =
  (typeof PORTFOLIO_OVERRIDE_REASON_CODES)[number];

export interface PortfolioRecommendation {
  recommendationId: string;
  repositoryIds: string[];
  action: PortfolioRecommendationAction;
  lifecycle: PortfolioRecommendationLifecycle;
  rationale: string;
  confidence: PortfolioRecommendationConfidence;
  eligibleActions: PortfolioRecommendationAction[];
  citationIds: string[];
  contradictions: string[];
  decisionHistory?: PortfolioDecisionEvent[];
}

export interface PortfolioRecommendationConfidence {
  coverage: number;
  citations: number;
  classifierAgreement: number;
  ruleSupport: number;
  weightedConfidence: number;
}

export interface PortfolioDecisionEvent {
  eventId: string;
  lifecycle: PortfolioRecommendationLifecycle;
  action: PortfolioRecommendationAction;
  occurredAt: string;
  receiptObjectSha256: string;
}

export interface PortfolioListResponse<T> {
  items: T[];
}

export interface StartPortfolioRunResponse {
  runId: string;
  status: PortfolioRunStatus;
}

export interface ChatImportBody {
  projectId: string;
  conversations: unknown;
}

export interface ChatImportResponse {
  importedCount: number;
  receiptId: string;
}

export interface RecommendationOverrideBody {
  action: PortfolioRecommendationAction;
  reasonCode: PortfolioOverrideReasonCode;
  explanation: string;
  providedBy: string;
}

export type RecommendationOverrideResponse = PortfolioRecommendation;
