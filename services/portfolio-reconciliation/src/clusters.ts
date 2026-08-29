import {
  OverlapClusterSchema,
  SCHEMA_VERSION,
  type OverlapCluster
} from "@unified-ai/contracts";
import { canonicalJson, sha256Hex } from "@unified-ai/evidence-index";
import { compareProfiles } from "./reconcile.js";
import type {
  DeterministicRepositoryProfile,
  OverlapEvidence
} from "./types.js";

export interface PortfolioClusterResult {
  clusters: OverlapCluster[];
  overlaps: OverlapEvidence[];
  standaloneRepositoryIds: string[];
}

function eligibleOverlap(overlap: OverlapEvidence): boolean {
  return overlap.samePurpose
    ? overlap.jaccard >= 0.6
    : overlap.sharedCapabilities.length >= 2 && overlap.jaccard >= 0.3;
}

function connectedComponents(
  repositoryIds: readonly string[],
  overlaps: readonly OverlapEvidence[]
): string[][] {
  const adjacency = new Map(repositoryIds.map((id) => [id, new Set<string>()]));
  for (const overlap of overlaps.filter(eligibleOverlap)) {
    adjacency.get(overlap.leftRepositoryId)?.add(overlap.rightRepositoryId);
    adjacency.get(overlap.rightRepositoryId)?.add(overlap.leftRepositoryId);
  }
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const repositoryId of [...repositoryIds].sort()) {
    if (visited.has(repositoryId)) {
      continue;
    }
    const pending = [repositoryId];
    const component: string[] = [];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || visited.has(current)) {
        continue;
      }
      visited.add(current);
      component.push(current);
      pending.push(...(adjacency.get(current) ?? []));
    }
    components.push(component.sort());
  }
  return components;
}

export function buildPortfolioClusters(
  profiles: readonly DeterministicRepositoryProfile[],
  createdAt: string
): PortfolioClusterResult {
  const overlaps: OverlapEvidence[] = [];
  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    const left = profiles[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < profiles.length;
      rightIndex += 1
    ) {
      const right = profiles[rightIndex];
      if (right !== undefined) {
        overlaps.push(compareProfiles(left, right));
      }
    }
  }
  const byId = new Map(
    profiles.map((profile) => [profile.binding.repositoryId, profile])
  );
  const components = connectedComponents([...byId.keys()], overlaps);
  const clusters = components
    .filter((component) => component.length >= 2)
    .map((component) => {
      const members = component
        .map((repositoryId) => byId.get(repositoryId))
        .filter(
          (profile): profile is DeterministicRepositoryProfile =>
            profile !== undefined
        );
      const relevant = overlaps.filter(
        (overlap) =>
          component.includes(overlap.leftRepositoryId) &&
          component.includes(overlap.rightRepositoryId) &&
          eligibleOverlap(overlap)
      );
      const sharedCapabilities = [
        ...new Set(relevant.flatMap((overlap) => overlap.sharedCapabilities))
      ].sort();
      const citationIds = [
        ...new Set(
          members.flatMap((member) =>
            member.citations.map((citation) => citation.citationId)
          )
        )
      ].sort();
      const digest = sha256Hex(canonicalJson({ component, sharedCapabilities }));
      return OverlapClusterSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        clusterId: `cluster-${digest.slice(0, 24)}`,
        createdAt,
        evidenceObjectSha256: digest,
        label: `Overlap across ${members.length} repositories`,
        rationale:
          "Deterministic purpose and normalized capability thresholds connect these repositories.",
        sharedCapabilities,
        repositories: members.map((member) => member.binding),
        citationIds
      });
    });
  const clusteredIds = new Set(
    clusters.flatMap((cluster) =>
      cluster.repositories.map((repository) => repository.repositoryId)
    )
  );
  return {
    clusters,
    overlaps,
    standaloneRepositoryIds: [...byId.keys()]
      .filter((repositoryId) => !clusteredIds.has(repositoryId))
      .sort()
  };
}
