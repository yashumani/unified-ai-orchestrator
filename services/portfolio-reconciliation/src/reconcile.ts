import type { RecommendationAction } from "@unified-ai/contracts";
import {
  calculateConfidence,
  classifierAction,
  classifierAgreement,
  evidenceCoverage,
  validCitationRatio
} from "./confidence.js";
import { jaccardSimilarity, normalizeLabel } from "./normalization.js";
import type {
  ClassifierResult,
  DeterministicRepositoryProfile,
  OverlapEvidence,
  RecommendationEvaluation
} from "./types.js";
import { REQUIRED_EVIDENCE_FAMILIES } from "./types.js";

const ADOPTABLE_CAPABILITIES = new Set([
  "orchestration",
  "evidence",
  "knowledge",
  "policy",
  "local model runtime"
]);

const DAY_MS = 86_400_000;

export function compareProfiles(
  left: DeterministicRepositoryProfile,
  right: DeterministicRepositoryProfile
): OverlapEvidence {
  const overlap = jaccardSimilarity(left.capabilities, right.capabilities);
  return {
    leftRepositoryId: left.binding.repositoryId,
    rightRepositoryId: right.binding.repositoryId,
    samePurpose: normalizeLabel(left.purpose) === normalizeLabel(right.purpose),
    sharedCapabilities: overlap.shared,
    jaccard: overlap.score
  };
}

function isComplete(profile: DeterministicRepositoryProfile): boolean {
  return REQUIRED_EVIDENCE_FAMILIES.every(
    (family) => profile.evidenceFamilies[family] === "complete"
  );
}

function isInactiveFor180Days(
  profile: DeterministicRepositoryProfile,
  now: Date
): boolean {
  if (profile.lastCommitAt === null) {
    return true;
  }
  const lastCommit = Date.parse(profile.lastCommitAt);
  return Number.isFinite(lastCommit) && now.getTime() - lastCommit >= 180 * DAY_MS;
}

export function eligibleRecommendationActions(
  profile: DeterministicRepositoryProfile,
  peers: readonly DeterministicRepositoryProfile[],
  now = new Date()
): RecommendationAction[] {
  if (!isComplete(profile) || profile.contradictions.length > 0) {
    return ["defer-insufficient-evidence"];
  }

  const actions = new Set<RecommendationAction>();
  const comparisons = peers
    .filter(
      (peer) => peer.binding.repositoryId !== profile.binding.repositoryId
    )
    .map((peer) => ({ peer, overlap: compareProfiles(profile, peer) }));

  if (
    comparisons.some(
      ({ overlap }) => overlap.samePurpose && overlap.jaccard >= 0.6
    )
  ) {
    actions.add("combine-with-peer");
  }
  if (
    comparisons.some(
      ({ overlap }) =>
        !overlap.samePurpose &&
        overlap.sharedCapabilities.length >= 2 &&
        overlap.jaccard >= 0.3
    )
  ) {
    actions.add("extract-shared-component");
  }
  if (
    !profile.isOrchestrator &&
    profile.capabilities
      .map(normalizeLabel)
      .some((capability) => ADOPTABLE_CAPABILITIES.has(capability))
  ) {
    actions.add("adopt-capability-into-orchestrator");
  }

  if (
    profile.supersededByRepositoryId !== null &&
    profile.openWorkItemCount === 0 &&
    isInactiveFor180Days(profile, now)
  ) {
    const supersedingPeer = peers.find(
      (peer) =>
        peer.binding.repositoryId === profile.supersededByRepositoryId
    );
    if (supersedingPeer !== undefined) {
      const uniqueCapabilities = jaccardSimilarity(
        profile.capabilities,
        supersedingPeer.capabilities
      );
      const hasNoUniqueCapability =
        uniqueCapabilities.shared.length ===
        new Set(profile.capabilities.map(normalizeLabel)).size;
      const peerIsHealthier =
        !supersedingPeer.archived &&
        (supersedingPeer.lastCommitAt === null ||
          profile.lastCommitAt === null ||
          Date.parse(supersedingPeer.lastCommitAt) >
            Date.parse(profile.lastCommitAt));
      if (hasNoUniqueCapability && peerIsHealthier) {
        actions.add("archive-candidate");
      }
    }
  }

  if (actions.size === 0) {
    actions.add("keep-standalone");
  }
  return [...actions].sort((left, right) => left.localeCompare(right));
}

function preferredDeterministicAction(
  eligibleActions: readonly RecommendationAction[]
): RecommendationAction {
  const priority: readonly RecommendationAction[] = [
    "defer-insufficient-evidence",
    "combine-with-peer",
    "extract-shared-component",
    "adopt-capability-into-orchestrator",
    "archive-candidate",
    "keep-standalone"
  ];
  return priority.find((action) => eligibleActions.includes(action)) ??
    "defer-insufficient-evidence";
}

export function evaluateRecommendation(input: {
  profile: DeterministicRepositoryProfile;
  peers: readonly DeterministicRepositoryProfile[];
  classifier: ClassifierResult;
  now?: Date;
}): RecommendationEvaluation {
  const eligibleActions = eligibleRecommendationActions(
    input.profile,
    input.peers,
    input.now
  );
  const agreedAction = classifierAction(
    input.classifier.first,
    input.classifier.second
  );
  const action =
    agreedAction !== null && eligibleActions.includes(agreedAction)
      ? agreedAction
      : preferredDeterministicAction(eligibleActions);
  const classifierCitationIds = [
    ...new Set([
      ...(input.classifier.first?.citationIds ?? []),
      ...(input.classifier.second?.citationIds ?? [])
    ])
  ].sort((left, right) => left.localeCompare(right));
  const citationIds =
    classifierCitationIds.length > 0
      ? classifierCitationIds
      : input.profile.citations
          .map((citation) => citation.citationId)
          .sort((left, right) => left.localeCompare(right));
  const citations = validCitationRatio(input.profile, citationIds);
  const confidence = calculateConfidence({
    coverage: evidenceCoverage(input.profile),
    citations,
    classifierAgreement: classifierAgreement(
      input.classifier.first,
      input.classifier.second
    ),
    ruleSupport: eligibleActions.includes(action) ? 1 : 0
  });
  const allCitationsValid = citationIds.length > 0 && citations === 1;
  const autoFinalizationEligible =
    action !== "defer-insufficient-evidence" &&
    confidence.weightedConfidence >= 0.9 &&
    isComplete(input.profile) &&
    allCitationsValid &&
    confidence.classifierAgreement === 1 &&
    eligibleActions.includes(action) &&
    input.profile.contradictions.length === 0;
  const lifecycle =
    action === "defer-insufficient-evidence"
      ? "deferred"
      : autoFinalizationEligible
        ? "auto-finalized"
        : "draft";
  const rationale =
    input.classifier.first !== null &&
    input.classifier.second !== null &&
    classifierAgreement(
      input.classifier.first,
      input.classifier.second
    ) === 1
      ? input.classifier.first.rationale
      : `Deterministic rules selected ${action}; model output was unavailable or did not fully agree.`;
  return {
    action,
    lifecycle,
    eligibleActions,
    confidence,
    citationIds,
    rationale,
    autoFinalizationEligible,
    warnings: [...input.classifier.warnings]
  };
}
