import type {
  EvidenceFamily,
  RecommendationAction,
  RecommendationConfidence,
  RecommendationLifecycle,
  RepositoryCitation,
  RepositoryEvidenceBinding
} from "@unified-ai/contracts";

export const REQUIRED_EVIDENCE_FAMILIES = [
  "identity",
  "default-branch",
  "documentation",
  "manifests",
  "workflows",
  "releases",
  "commits",
  "work-items"
] as const satisfies readonly EvidenceFamily[];

export type EvidenceFamilyState = "complete" | "incomplete";

export interface DeterministicRepositoryProfile {
  binding: RepositoryEvidenceBinding;
  fullName: string;
  purpose: string;
  capabilities: string[];
  technologyTags: string[];
  evidenceFamilies: Record<EvidenceFamily, EvidenceFamilyState>;
  citations: RepositoryCitation[];
  contradictions: string[];
  visibility: "public" | "private" | "internal" | "unknown";
  licenseSpdxId: string | null;
  archived: boolean;
  openWorkItemCount: number;
  lastCommitAt: string | null;
  isOrchestrator: boolean;
  supersededByRepositoryId: string | null;
}

export interface ClassifierProposal {
  purpose: string;
  action: RecommendationAction;
  rationale: string;
  citationIds: string[];
}

export interface ClassifierResult {
  first: ClassifierProposal | null;
  second: ClassifierProposal | null;
  warnings: string[];
}

export interface PortfolioClassifier {
  classify(
    profile: DeterministicRepositoryProfile,
    eligibleActions: readonly RecommendationAction[],
    signal?: AbortSignal
  ): Promise<ClassifierResult>;
}

export interface OverlapEvidence {
  leftRepositoryId: string;
  rightRepositoryId: string;
  samePurpose: boolean;
  sharedCapabilities: string[];
  jaccard: number;
}

export interface RecommendationEvaluation {
  action: RecommendationAction;
  lifecycle: RecommendationLifecycle;
  eligibleActions: RecommendationAction[];
  confidence: RecommendationConfidence;
  citationIds: string[];
  rationale: string;
  autoFinalizationEligible: boolean;
  warnings: string[];
}
