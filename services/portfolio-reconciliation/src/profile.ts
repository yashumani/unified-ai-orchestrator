import {
  RepositoryCitationSchema,
  RepositoryEvidenceRecordSchema,
  RepositoryProfileSchema,
  RepositorySnapshotSchema,
  SCHEMA_VERSION,
  type EvidenceFamily,
  type RepositoryCitation,
  type RepositoryEvidenceRecord,
  type RepositoryProfile,
  type RepositorySnapshot
} from "@unified-ai/contracts";
import { canonicalJson, sha256Hex } from "@unified-ai/evidence-index";
import type {
  RepositoryFileEvidence,
  RepositoryInventoryItem,
  RepositoryPortfolioSnapshot
} from "@unified-ai/portfolio-ingestion";
import { normalizeLabels } from "./normalization.js";
import {
  REQUIRED_EVIDENCE_FAMILIES,
  type DeterministicRepositoryProfile,
  type EvidenceFamilyState
} from "./types.js";

export interface RepositoryProfileArtifacts {
  snapshot: RepositorySnapshot;
  profile: RepositoryProfile;
  citations: RepositoryCitation[];
  evidenceObjects: Array<{
    family: EvidenceFamily;
    sha256: string;
    value: unknown;
  }>;
  deterministic: DeterministicRepositoryProfile;
}

interface FamilyPayload {
  family: EvidenceFamily;
  locator: string;
  payload: unknown;
}

const CAPABILITY_PATTERNS: ReadonlyArray<{
  capability: string;
  pattern: RegExp;
}> = [
  { capability: "orchestration", pattern: /\b(orchestrat|agentic|multi-agent|copilot)\w*/iu },
  { capability: "evidence", pattern: /\b(evidence|provenance|receipt|audit)\w*/iu },
  { capability: "knowledge", pattern: /\b(knowledge|retrieval|rag|vector)\w*/iu },
  { capability: "policy", pattern: /\b(policy|governance|compliance)\w*/iu },
  { capability: "local model runtime", pattern: /\b(ollama|local[- ]llm|local model)\b/iu },
  { capability: "machine learning", pattern: /\b(machine learning|mlops|model training)\b/iu },
  { capability: "deployment", pattern: /\b(deploy|container|docker|kubernetes|azure)\w*/iu },
  { capability: "web interface", pattern: /\b(react|angular|frontend|dashboard|web app)\b/iu },
  { capability: "chat", pattern: /\b(chat|conversation|assistant)\w*/iu },
  { capability: "data pipeline", pattern: /\b(pipeline|etl|ingestion|workflow)\w*/iu },
  { capability: "browser automation", pattern: /\b(playwright|browser automation|crawler)\b/iu },
  { capability: "document processing", pattern: /\b(document|pdf|ocr|spreadsheet)\w*/iu }
];

function idPart(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized.length > 0 ? normalized.slice(0, 80) : "repository";
}

function hash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function capturedRevision(snapshot: RepositoryPortfolioSnapshot): string {
  return (
    snapshot.beforeRef?.commitSha ??
    snapshot.afterRef?.commitSha ??
    hash({ unavailableRepositoryRevision: snapshot.fullName })
  );
}

function selectedFiles(
  snapshot: RepositoryPortfolioSnapshot,
  kinds: readonly RepositoryFileEvidence["kind"][]
): RepositoryFileEvidence[] {
  return snapshot.files.filter((file) => kinds.includes(file.kind));
}

function familyPayloads(
  inventory: RepositoryInventoryItem,
  snapshot: RepositoryPortfolioSnapshot
): FamilyPayload[] {
  return [
    {
      family: "identity",
      locator: `github:${snapshot.fullName}`,
      payload: {
        id: inventory.id,
        owner: inventory.owner,
        name: inventory.name,
        fullName: snapshot.fullName,
        visibility: snapshot.visibility ?? inventory.visibility,
        archived: inventory.archived,
        fork: inventory.fork,
        topics: snapshot.topics,
        languages: snapshot.languages,
        license: snapshot.license ?? null,
        status: snapshot.status,
        renamedTo: snapshot.renamedTo ?? null
      }
    },
    {
      family: "default-branch",
      locator: `github:${snapshot.fullName}#${snapshot.defaultBranch ?? inventory.defaultBranch}`,
      payload: {
        defaultBranch: snapshot.defaultBranch ?? inventory.defaultBranch,
        beforeRef: snapshot.beforeRef ?? null,
        afterRef: snapshot.afterRef ?? null,
        treeSha: snapshot.treeSha ?? null,
        treeTruncated: snapshot.treeTruncated ?? false,
        attempts: snapshot.attempts
      }
    },
    {
      family: "documentation",
      locator: `github:${snapshot.fullName}/documentation`,
      payload: selectedFiles(snapshot, ["readme", "documentation"])
    },
    {
      family: "manifests",
      locator: `github:${snapshot.fullName}/manifests`,
      payload: selectedFiles(snapshot, ["manifest"])
    },
    {
      family: "workflows",
      locator: `github:${snapshot.fullName}/workflows`,
      payload: selectedFiles(snapshot, ["workflow", "deployment"])
    },
    {
      family: "releases",
      locator: `github:${snapshot.fullName}/releases`,
      payload: snapshot.releases
    },
    {
      family: "commits",
      locator: `github:${snapshot.fullName}/commits`,
      payload: snapshot.recentCommits
    },
    {
      family: "work-items",
      locator: `github:${snapshot.fullName}/work-items`,
      payload: {
        openIssues: snapshot.openIssues,
        openPullRequests: snapshot.openPullRequests,
        recentlyClosed: snapshot.recentlyClosedWorkItems
      }
    }
  ];
}

function familyStates(
  snapshot: RepositoryPortfolioSnapshot
): Record<EvidenceFamily, EvidenceFamilyState> {
  const globallyComplete =
    snapshot.status === "complete" &&
    snapshot.gaps.length === 0 &&
    snapshot.beforeRef !== undefined &&
    snapshot.afterRef !== undefined &&
    snapshot.beforeRef.commitSha === snapshot.afterRef.commitSha &&
    snapshot.beforeRef.treeSha === snapshot.afterRef.treeSha;
  const states = Object.fromEntries(
    REQUIRED_EVIDENCE_FAMILIES.map((family) => [
      family,
      globallyComplete ? "complete" : "incomplete"
    ])
  ) as Record<EvidenceFamily, EvidenceFamilyState>;
  if (snapshot.treeTruncated === true) {
    states.documentation = "incomplete";
    states.manifests = "incomplete";
    states.workflows = "incomplete";
  }
  if (snapshot.files.some((file) => !file.complete)) {
    states.documentation = "incomplete";
    states.manifests = "incomplete";
    states.workflows = "incomplete";
  }
  return states;
}

function boundedText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/giu, "[link]")
    .replace(/\b(?:ghp_|github_pat_)[A-Za-z0-9_]+\b/gu, "[credential]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

function documentedPurpose(
  inventory: RepositoryInventoryItem,
  snapshot: RepositoryPortfolioSnapshot
): string {
  const readme = snapshot.files.find(
    (file) => file.kind === "readme" && file.content !== null
  )?.content;
  const usefulLine = readme
    ?.split(/\r?\n/gu)
    .map((line) => line.replace(/^#+\s*/u, "").trim())
    .find(
      (line) =>
        line.length >= 12 &&
        !/^[-=![`#]/u.test(line) &&
        !/^badges?\b/iu.test(line)
    );
  if (usefulLine !== undefined) {
    return boundedText(usefulLine);
  }
  if (snapshot.topics.length > 0) {
    return `Repository focused on ${snapshot.topics.slice(0, 5).join(", ")}.`;
  }
  return `Repository ${inventory.name.replace(/[-_]+/gu, " ")}.`;
}

function detectCapabilities(
  snapshot: RepositoryPortfolioSnapshot
): string[] {
  const source = [
    snapshot.fullName,
    ...snapshot.topics,
    ...Object.keys(snapshot.languages),
    ...snapshot.files.flatMap((file) => [file.path, file.content ?? ""])
  ].join("\n");
  return normalizeLabels(
    CAPABILITY_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(
      ({ capability }) => capability
    )
  );
}

function technologyTags(snapshot: RepositoryPortfolioSnapshot): string[] {
  const manifests = snapshot.files
    .filter((file) => file.kind === "manifest")
    .map((file) => file.path.split("/").at(-1) ?? file.path);
  return normalizeLabels([
    ...Object.keys(snapshot.languages),
    ...snapshot.topics,
    ...manifests
  ]).slice(0, 100);
}

function familySummary(
  family: EvidenceFamily,
  payload: unknown,
  state: EvidenceFamilyState
): string {
  const itemCount = Array.isArray(payload)
    ? payload.length
    : typeof payload === "object" && payload !== null
      ? Object.keys(payload).length
      : 1;
  return `${family} query ${state}; ${itemCount} bounded evidence field${itemCount === 1 ? "" : "s"} recorded.`;
}

export function buildRepositoryProfileArtifacts(input: {
  inventory: RepositoryInventoryItem;
  snapshot: RepositoryPortfolioSnapshot;
  capturedAt: string;
  orchestratorFullName?: string;
}): RepositoryProfileArtifacts {
  const repositoryId = `repository-${input.inventory.id}`;
  const revision = capturedRevision(input.snapshot);
  const states = familyStates(input.snapshot);
  const payloads = familyPayloads(input.inventory, input.snapshot);
  const evidenceObjects = payloads.map((family) => {
    const value = {
      schemaVersion: SCHEMA_VERSION,
      repositoryId,
      capturedRevision: revision,
      family: family.family,
      payload: family.payload
    };
    return { family: family.family, sha256: hash(value), value };
  });
  const evidence = payloads.map((family): RepositoryEvidenceRecord => {
    const evidenceObjectSha256 = evidenceObjects.find(
      (object) => object.family === family.family
    )?.sha256;
    if (evidenceObjectSha256 === undefined) {
      throw new Error("portfolio evidence family object is missing");
    }
    return RepositoryEvidenceRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      evidenceId: `evidence-${idPart(repositoryId)}-${family.family}-${evidenceObjectSha256.slice(0, 12)}`,
      family: family.family,
      repositoryId,
      capturedRevision: revision,
      capturedAt: input.capturedAt,
      evidenceObjectSha256,
      summary: familySummary(
        family.family,
        family.payload,
        states[family.family]
      ),
      locator: family.locator
    });
  });
  const citations = evidence.map((record) =>
    RepositoryCitationSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      citationId: `citation-${idPart(repositoryId)}-${record.family}`,
      family: record.family,
      repositoryId,
      capturedRevision: revision,
      capturedAt: input.capturedAt,
      evidenceObjectSha256: record.evidenceObjectSha256,
      locator: record.locator ?? `github:${input.snapshot.fullName}`,
      statement: record.summary
    })
  );
  const binding = {
    repositoryId,
    capturedRevision: revision,
    capturedAt: input.capturedAt,
    evidenceObjectSha256: hash({ repositoryId, revision, evidence })
  };
  const snapshot = RepositorySnapshotSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    snapshotId: `snapshot-${idPart(repositoryId)}-${revision.slice(0, 12)}`,
    ...binding,
    evidence
  });
  const capabilities = detectCapabilities(input.snapshot);
  const purpose = documentedPurpose(input.inventory, input.snapshot);
  const tags = technologyTags(input.snapshot);
  const profile = RepositoryProfileSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    profileId: `profile-${idPart(repositoryId)}-${revision.slice(0, 12)}`,
    snapshotId: snapshot.snapshotId,
    ...binding,
    name: input.snapshot.fullName,
    summary: purpose,
    purposes: [purpose],
    capabilities,
    technologyTags: tags,
    citationIds: citations.map((citation) => citation.citationId)
  });
  const contradictions = input.snapshot.gaps
    .filter((gap) => gap.reason === "moving-head")
    .map(() => "The default branch changed during both capture attempts.");
  const openWorkItemIds = new Set([
    ...input.snapshot.openIssues.map((item) => item.id),
    ...input.snapshot.openPullRequests.map((item) => item.id)
  ]);
  return {
    snapshot,
    profile,
    citations,
    evidenceObjects,
    deterministic: {
      binding,
      fullName: input.snapshot.fullName,
      purpose,
      capabilities,
      technologyTags: tags,
      evidenceFamilies: states,
      citations,
      contradictions,
      visibility: input.snapshot.visibility ?? input.inventory.visibility,
      licenseSpdxId: input.snapshot.license?.spdxId ?? null,
      archived: input.inventory.archived,
      openWorkItemCount: openWorkItemIds.size,
      lastCommitAt:
        input.snapshot.recentCommits[0]?.committedAt ??
        input.snapshot.recentCommits[0]?.authoredAt ??
        null,
      isOrchestrator:
        input.orchestratorFullName?.toLowerCase() ===
        input.snapshot.fullName.toLowerCase(),
      supersededByRepositoryId: null
    }
  };
}
