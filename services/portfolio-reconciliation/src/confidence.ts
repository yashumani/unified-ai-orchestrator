import {
  RECOMMENDATION_CONFIDENCE_WEIGHTS,
  RecommendationConfidenceSchema,
  type RecommendationAction,
  type RecommendationConfidence
} from "@unified-ai/contracts";
import { normalizeLabel } from "./normalization.js";
import type {
  ClassifierProposal,
  DeterministicRepositoryProfile
} from "./types.js";
import { REQUIRED_EVIDENCE_FAMILIES } from "./types.js";

export function evidenceCoverage(
  profile: DeterministicRepositoryProfile
): number {
  const complete = REQUIRED_EVIDENCE_FAMILIES.filter(
    (family) => profile.evidenceFamilies[family] === "complete"
  ).length;
  return complete / REQUIRED_EVIDENCE_FAMILIES.length;
}

export function validCitationRatio(
  profile: DeterministicRepositoryProfile,
  citedIds: readonly string[]
): number {
  if (citedIds.length === 0) {
    return 0;
  }
  const validIds = new Set(
    profile.citations
      .filter(
        (citation) =>
          citation.repositoryId === profile.binding.repositoryId &&
          citation.capturedRevision === profile.binding.capturedRevision
      )
      .map((citation) => citation.citationId)
  );
  const uniqueRequested = new Set(citedIds);
  const validCount = [...uniqueRequested].filter((citationId) =>
    validIds.has(citationId)
  ).length;
  return validCount / uniqueRequested.size;
}

export function classifierAgreement(
  first: ClassifierProposal | null,
  second: ClassifierProposal | null
): number {
  if (first === null || second === null) {
    return 0;
  }
  if (normalizeLabel(first.purpose) !== normalizeLabel(second.purpose)) {
    return 0;
  }
  return first.action === second.action ? 1 : 0.5;
}

export function calculateConfidence(input: {
  coverage: number;
  citations: number;
  classifierAgreement: number;
  ruleSupport: number;
}): RecommendationConfidence {
  const weightedConfidence =
    input.coverage * RECOMMENDATION_CONFIDENCE_WEIGHTS.coverage +
    input.citations * RECOMMENDATION_CONFIDENCE_WEIGHTS.citations +
    input.classifierAgreement *
      RECOMMENDATION_CONFIDENCE_WEIGHTS.classifierAgreement +
    input.ruleSupport * RECOMMENDATION_CONFIDENCE_WEIGHTS.ruleSupport;
  return RecommendationConfidenceSchema.parse({
    ...input,
    weightedConfidence
  });
}

export function classifierAction(
  first: ClassifierProposal | null,
  second: ClassifierProposal | null
): RecommendationAction | null {
  return first !== null &&
    second !== null &&
    first.action === second.action &&
    normalizeLabel(first.purpose) === normalizeLabel(second.purpose)
    ? first.action
    : null;
}
