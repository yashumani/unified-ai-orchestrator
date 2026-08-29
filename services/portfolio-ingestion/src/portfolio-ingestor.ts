import { GitHubReadError, GitHubRestClient } from "./github-rest-client.js";
import type {
  GitHubIngestionGap,
  GitHubReadResult,
  GitHubVisibility,
  PortfolioIngestionCheckpoint,
  PortfolioIngestionOptions,
  PortfolioIngestionResult,
  RepositoryArtifactKind,
  RepositoryCommentEvidence,
  RepositoryCommitEvidence,
  RepositoryFileEvidence,
  RepositoryInventoryItem,
  RepositoryLicenseEvidence,
  RepositoryPortfolioSnapshot,
  RepositoryReleaseEvidence,
  RepositoryReviewEvidence,
  RepositoryWorkItemEvidence,
  GitRefFingerprint
} from "./types.js";

type JsonRecord = Record<string, unknown>;

const RECENT_COMMIT_LIMIT = 100;
const RECENT_CLOSED_WORK_ITEM_LIMIT = 20;
const DEFAULT_MAX_ARTIFACT_FILES = 500;
const DEFAULT_MAX_ARTIFACT_BYTES = 1_000_000;

const MANIFEST_BASENAMES = new Set([
  "build.gradle",
  "build.gradle.kts",
  "cargo.lock",
  "cargo.toml",
  "composer.json",
  "composer.lock",
  "deno.json",
  "deno.jsonc",
  "gemfile",
  "gemfile.lock",
  "go.mod",
  "go.sum",
  "package-lock.json",
  "package.json",
  "pipfile",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pom.xml",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "yarn.lock"
]);

const DEPLOYMENT_BASENAMES = new Set([
  "azure-pipelines.yml",
  "azure-pipelines.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
  "dockerfile",
  "fly.toml",
  "netlify.toml",
  "render.yaml",
  "render.yml",
  "vercel.json"
]);

export interface GitHubPortfolioIngestorOptions {
  client: GitHubRestClient;
  now?: () => Date;
  maxArtifactFiles?: number;
  maxArtifactBytes?: number;
}

interface RepositoryAttempt {
  snapshot: RepositoryPortfolioSnapshot;
  moved: boolean;
}

interface TreeEntry {
  path: string;
  sha: string | null;
  size: number | null;
}

interface ArtifactCandidate extends TreeEntry {
  kind: RepositoryArtifactKind;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function nestedRecord(record: JsonRecord, key: string): JsonRecord | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function visibilityValue(value: unknown, privateValue: unknown): GitHubVisibility {
  if (value === "public" || value === "private" || value === "internal") {
    return value;
  }
  if (privateValue === true) return "private";
  if (privateValue === false) return "public";
  return "unknown";
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function encodeContentPath(value: string): string {
  return value.split("/").map(encodeSegment).join("/");
}

function makeGap(
  kind: GitHubIngestionGap["kind"],
  reason: GitHubIngestionGap["reason"],
  url: string,
  detail: string,
  status: number | null = null,
  replacementUrl: string | null = null,
  retryAfterMs: number | null = null
): GitHubIngestionGap {
  return { kind, reason, url, status, detail, replacementUrl, retryAfterMs };
}

function errorGap(error: unknown, path: string): GitHubIngestionGap {
  if (error instanceof GitHubReadError) {
    return makeGap(
      "incomplete",
      error.status === null ? "network-error" : "invalid-response",
      error.url,
      error.message,
      error.status,
      null,
      error.retryAfterMs
    );
  }
  return makeGap(
    "incomplete",
    "network-error",
    path,
    "An unexpected error interrupted the GitHub read."
  );
}

function parseInventoryItem(value: unknown): RepositoryInventoryItem | null {
  if (!isRecord(value)) return null;
  const owner = nestedRecord(value, "owner");
  const id = numberValue(value.id);
  const name = stringValue(value.name);
  const fullName = stringValue(value.full_name);
  const ownerLogin = owner ? stringValue(owner.login) : null;
  const defaultBranch = stringValue(value.default_branch);
  if (
    id === null ||
    name === null ||
    fullName === null ||
    ownerLogin === null ||
    defaultBranch === null
  ) {
    return null;
  }
  return {
    id,
    owner: ownerLogin,
    name,
    fullName,
    visibility: visibilityValue(value.visibility, value.private),
    defaultBranch,
    archived: booleanValue(value.archived) ?? false,
    fork: booleanValue(value.fork) ?? false,
    updatedAt: stringValue(value.updated_at)
  };
}

function classifyArtifact(path: string): RepositoryArtifactKind | null {
  const normalized = path.replaceAll("\\", "/");
  const lower = normalized.toLowerCase();
  const basename = lower.split("/").at(-1) ?? lower;
  if (/^readme(?:\.|$)/u.test(basename)) return "readme";
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(lower)) return "workflow";
  if (
    DEPLOYMENT_BASENAMES.has(basename) ||
    /^(deploy|deployment|deployments|helm|infra|infrastructure|k8s|kubernetes|terraform)\//u.test(
      lower
    ) ||
    /(^|\/)dockerfile(?:\.[^/]+)?$/u.test(lower)
  ) {
    return "deployment";
  }
  if (
    MANIFEST_BASENAMES.has(basename) ||
    /^requirements[^/]*\.txt$/u.test(basename) ||
    /\.(?:csproj|fsproj|sln|vbproj)$/u.test(basename)
  ) {
    return "manifest";
  }
  if (
    /^(docs?|documentation)\//u.test(lower) &&
    /\.(?:adoc|md|mdx|rst|txt)$/u.test(lower)
  ) {
    return "documentation";
  }
  return null;
}

function parseTreeEntries(value: unknown): TreeEntry[] {
  if (!isRecord(value) || !Array.isArray(value.tree)) return [];
  const entries: TreeEntry[] = [];
  for (const item of value.tree) {
    if (!isRecord(item) || item.type !== "blob") continue;
    const path = stringValue(item.path);
    if (path === null) continue;
    entries.push({
      path,
      sha: stringValue(item.sha),
      size: numberValue(item.size)
    });
  }
  return entries;
}

function decodeContent(record: JsonRecord): string | null {
  const content = stringValue(record.content);
  const encoding = stringValue(record.encoding);
  if (content === null) return null;
  if (encoding === "base64") {
    return Buffer.from(content.replaceAll("\n", ""), "base64").toString("utf8");
  }
  return content;
}

function parseFileEvidence(
  value: unknown,
  kind: RepositoryArtifactKind,
  fallbackPath: string,
  maxBytes: number
): RepositoryFileEvidence | null {
  if (!isRecord(value)) return null;
  const path = stringValue(value.path) ?? fallbackPath;
  const size = numberValue(value.size);
  const encoding = stringValue(value.encoding);
  if (size !== null && size > maxBytes) {
    return {
      path,
      kind,
      sha: stringValue(value.sha),
      size,
      content: null,
      encoding,
      complete: false
    };
  }
  return {
    path,
    kind,
    sha: stringValue(value.sha),
    size,
    content: decodeContent(value),
    encoding,
    complete: true
  };
}

function parseRelease(value: unknown): RepositoryReleaseEvidence | null {
  if (!isRecord(value)) return null;
  const id = numberValue(value.id);
  const tagName = stringValue(value.tag_name);
  if (id === null || tagName === null) return null;
  return {
    id,
    tagName,
    name: stringValue(value.name),
    publishedAt: stringValue(value.published_at),
    draft: booleanValue(value.draft) ?? false,
    prerelease: booleanValue(value.prerelease) ?? false
  };
}

function parseCommit(value: unknown): RepositoryCommitEvidence | null {
  if (!isRecord(value)) return null;
  const sha = stringValue(value.sha);
  const commit = nestedRecord(value, "commit");
  if (sha === null || commit === null) return null;
  const author = nestedRecord(commit, "author");
  const committer = nestedRecord(commit, "committer");
  const account = nestedRecord(value, "author");
  return {
    sha,
    message: stringValue(commit.message) ?? "",
    authoredAt: author ? stringValue(author.date) : null,
    committedAt: committer ? stringValue(committer.date) : null,
    authorLogin: account ? stringValue(account.login) : null
  };
}

function parseComment(value: unknown): RepositoryCommentEvidence | null {
  if (!isRecord(value)) return null;
  const id = numberValue(value.id);
  if (id === null) return null;
  const user = nestedRecord(value, "user");
  return {
    id,
    body: stringValue(value.body),
    createdAt: stringValue(value.created_at),
    updatedAt: stringValue(value.updated_at),
    authorLogin: user ? stringValue(user.login) : null
  };
}

function parseReview(value: unknown): RepositoryReviewEvidence | null {
  const comment = parseComment(value);
  if (comment === null || !isRecord(value)) return null;
  return {
    ...comment,
    state: stringValue(value.state),
    submittedAt: stringValue(value.submitted_at),
    commitId: stringValue(value.commit_id)
  };
}

function parseWorkItem(
  value: unknown,
  forcedKind?: "issue" | "pull-request"
): RepositoryWorkItemEvidence | null {
  if (!isRecord(value)) return null;
  const id = numberValue(value.id);
  const number = numberValue(value.number);
  const title = stringValue(value.title);
  const state = value.state === "open" || value.state === "closed" ? value.state : null;
  if (id === null || number === null || title === null || state === null) return null;
  const kind = forcedKind ?? (isRecord(value.pull_request) ? "pull-request" : "issue");
  const user = nestedRecord(value, "user");
  const head = nestedRecord(value, "head");
  const base = nestedRecord(value, "base");
  return {
    id,
    number,
    kind,
    title,
    state,
    updatedAt: stringValue(value.updated_at),
    createdAt: stringValue(value.created_at),
    closedAt: stringValue(value.closed_at),
    authorLogin: user ? stringValue(user.login) : null,
    headSha: head ? stringValue(head.sha) : null,
    baseSha: base ? stringValue(base.sha) : null,
    comments: [],
    reviews: [],
    reviewComments: []
  };
}

function minimalSnapshot(
  item: RepositoryInventoryItem,
  status: RepositoryPortfolioSnapshot["status"],
  gaps: GitHubIngestionGap[],
  renamedTo?: string
): RepositoryPortfolioSnapshot {
  return {
    requestedFullName: item.fullName,
    fullName: renamedTo ?? item.fullName,
    status,
    ...(renamedTo ? { renamedTo } : {}),
    attempts: 1,
    files: [],
    releases: [],
    languages: {},
    topics: [],
    recentCommits: [],
    openIssues: [],
    openPullRequests: [],
    recentlyClosedWorkItems: [],
    gaps
  };
}

function renamedFullName(replacementUrl: string | null): string | undefined {
  if (replacementUrl === null) return undefined;
  const segments = new URL(replacementUrl).pathname.split("/").filter(Boolean);
  const reposIndex = segments.lastIndexOf("repos");
  if (reposIndex < 0 || segments.length < reposIndex + 3) return undefined;
  const owner = segments[reposIndex + 1];
  const name = segments[reposIndex + 2];
  return owner && name ? `${decodeURIComponent(owner)}/${decodeURIComponent(name)}` : undefined;
}

export class GitHubPortfolioIngestor {
  readonly #client: GitHubRestClient;
  readonly #now: () => Date;
  readonly #maxArtifactFiles: number;
  readonly #maxArtifactBytes: number;

  constructor(options: GitHubPortfolioIngestorOptions) {
    this.#client = options.client;
    this.#now = options.now ?? (() => new Date());
    this.#maxArtifactFiles = options.maxArtifactFiles ?? DEFAULT_MAX_ARTIFACT_FILES;
    this.#maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(this.#maxArtifactFiles) || this.#maxArtifactFiles < 1) {
      throw new TypeError("maxArtifactFiles must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.#maxArtifactBytes) || this.#maxArtifactBytes < 1) {
      throw new TypeError("maxArtifactBytes must be a positive integer.");
    }
  }

  async #readJson<T>(
    path: string,
    gaps: GitHubIngestionGap[],
    signal: AbortSignal | undefined,
    ignoreNotFound = false
  ): Promise<T | null> {
    let result: GitHubReadResult<T>;
    try {
      result = await this.#client.requestJson<T>({
        path,
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      gaps.push(errorGap(error, path));
      return null;
    }
    if (result.kind === "ok" || result.kind === "not-modified") {
      return result.data;
    }
    if (ignoreNotFound && result.kind === "deleted") {
      return null;
    }
    gaps.push(result.gap);
    return null;
  }

  async #readPages<T>(
    path: string,
    gaps: GitHubIngestionGap[],
    signal: AbortSignal | undefined
  ): Promise<T[]> {
    try {
      const result = await this.#client.paginate<T>({
        path,
        ...(signal ? { signal } : {})
      });
      gaps.push(...result.gaps);
      return result.items;
    } catch (error) {
      gaps.push(errorGap(error, path));
      return [];
    }
  }

  async #ownedInventory(signal: AbortSignal | undefined): Promise<{
    items: RepositoryInventoryItem[];
    complete: boolean;
    gaps: GitHubIngestionGap[];
  }> {
    const path = "/user/repos?affiliation=owner&per_page=100&sort=full_name&direction=asc";
    const gaps: GitHubIngestionGap[] = [];
    let rawItems: unknown[] = [];
    let complete = false;
    try {
      const result = await this.#client.paginate<unknown>({
        path,
        ...(signal ? { signal } : {})
      });
      rawItems = result.items;
      gaps.push(...result.gaps);
      complete = result.complete;
    } catch (error) {
      gaps.push(errorGap(error, path));
    }
    const items: RepositoryInventoryItem[] = [];
    for (const rawItem of rawItems) {
      const parsed = parseInventoryItem(rawItem);
      if (parsed) {
        items.push(parsed);
      } else {
        gaps.push(
          makeGap(
            "incomplete",
            "invalid-response",
            path,
            "An owned-repository inventory row was malformed."
          )
        );
        complete = false;
      }
    }
    items.sort((left, right) => left.fullName.localeCompare(right.fullName, "en"));
    return { items, complete: complete && gaps.length === 0, gaps };
  }

  async #fingerprint(
    repositoryPath: string,
    branch: string,
    gaps: GitHubIngestionGap[],
    signal: AbortSignal | undefined
  ): Promise<GitRefFingerprint | null> {
    const refPath = `${repositoryPath}/git/ref/heads/${encodeSegment(branch)}`;
    const ref = await this.#readJson<JsonRecord>(refPath, gaps, signal);
    const commitSha = ref && nestedRecord(ref, "object")
      ? stringValue(nestedRecord(ref, "object")?.sha)
      : null;
    if (commitSha === null) {
      if (ref !== null) {
        gaps.push(
          makeGap(
            "incomplete",
            "invalid-response",
            refPath,
            "The default-branch ref response did not contain a commit SHA."
          )
        );
      }
      return null;
    }
    const commitPath = `${repositoryPath}/git/commits/${encodeSegment(commitSha)}`;
    const commit = await this.#readJson<JsonRecord>(commitPath, gaps, signal);
    const treeSha = commit && nestedRecord(commit, "tree")
      ? stringValue(nestedRecord(commit, "tree")?.sha)
      : null;
    if (treeSha === null) {
      if (commit !== null) {
        gaps.push(
          makeGap(
            "incomplete",
            "invalid-response",
            commitPath,
            "The Git commit response did not contain a tree SHA."
          )
        );
      }
      return null;
    }
    return {
      branch,
      commitSha,
      treeSha,
      observedAt: this.#now().toISOString()
    };
  }

  async #artifactFiles(
    repositoryPath: string,
    commitSha: string,
    tree: JsonRecord,
    gaps: GitHubIngestionGap[],
    signal: AbortSignal | undefined
  ): Promise<RepositoryFileEvidence[]> {
    const files: RepositoryFileEvidence[] = [];
    const readmePath = `${repositoryPath}/readme?ref=${encodeURIComponent(commitSha)}`;
    const readme = await this.#readJson<JsonRecord>(readmePath, gaps, signal, true);
    if (readme !== null) {
      const parsed = parseFileEvidence(readme, "readme", "README", this.#maxArtifactBytes);
      if (parsed) files.push(parsed);
      else {
        gaps.push(
          makeGap(
            "incomplete",
            "invalid-response",
            readmePath,
            "The README response was malformed."
          )
        );
      }
    }

    const candidates: ArtifactCandidate[] = [];
    for (const entry of parseTreeEntries(tree)) {
      const kind = classifyArtifact(entry.path);
      if (kind === null || kind === "readme") continue;
      candidates.push({ ...entry, kind });
    }
    candidates.sort((left, right) => left.path.localeCompare(right.path, "en"));
    if (candidates.length > this.#maxArtifactFiles) {
      gaps.push(
        makeGap(
          "incomplete",
          "artifact-limit",
          repositoryPath,
          `Artifact discovery found ${candidates.length} files; only the first ${this.#maxArtifactFiles} deterministic paths were read.`
        )
      );
    }
    for (const candidate of candidates.slice(0, this.#maxArtifactFiles)) {
      const contentPath = `${repositoryPath}/contents/${encodeContentPath(candidate.path)}?ref=${encodeURIComponent(commitSha)}`;
      const value = await this.#readJson<JsonRecord>(contentPath, gaps, signal);
      if (value === null) continue;
      const parsed = parseFileEvidence(
        value,
        candidate.kind,
        candidate.path,
        this.#maxArtifactBytes
      );
      if (parsed) {
        files.push(parsed);
        if (!parsed.complete) {
          gaps.push(
            makeGap(
              "incomplete",
              "artifact-limit",
              contentPath,
              `Artifact ${candidate.path} exceeds the ${this.#maxArtifactBytes}-byte content limit.`
            )
          );
        }
      } else {
        gaps.push(
          makeGap(
            "incomplete",
            "artifact-unavailable",
            contentPath,
            `Artifact ${candidate.path} could not be decoded.`
          )
        );
      }
    }
    return files;
  }

  async #hydrateWorkItem(
    repositoryPath: string,
    value: unknown,
    gaps: GitHubIngestionGap[],
    signal: AbortSignal | undefined,
    forcedKind?: "issue" | "pull-request"
  ): Promise<RepositoryWorkItemEvidence | null> {
    const item = parseWorkItem(value, forcedKind);
    if (item === null) {
      gaps.push(
        makeGap(
          "incomplete",
          "invalid-response",
          repositoryPath,
          "A GitHub work item was malformed."
        )
      );
      return null;
    }
    const comments = await this.#readPages<unknown>(
      `${repositoryPath}/issues/${item.number}/comments?per_page=100`,
      gaps,
      signal
    );
    item.comments = comments
      .map(parseComment)
      .filter((entry): entry is RepositoryCommentEvidence => entry !== null);
    if (item.kind === "pull-request") {
      const reviews = await this.#readPages<unknown>(
        `${repositoryPath}/pulls/${item.number}/reviews?per_page=100`,
        gaps,
        signal
      );
      const reviewComments = await this.#readPages<unknown>(
        `${repositoryPath}/pulls/${item.number}/comments?per_page=100`,
        gaps,
        signal
      );
      item.reviews = reviews
        .map(parseReview)
        .filter((entry): entry is RepositoryReviewEvidence => entry !== null);
      item.reviewComments = reviewComments
        .map(parseComment)
        .filter((entry): entry is RepositoryCommentEvidence => entry !== null);
    }
    return item;
  }

  async #hydrateWorkItems(
    repositoryPath: string,
    values: unknown[],
    gaps: GitHubIngestionGap[],
    signal: AbortSignal | undefined,
    forcedKind?: "issue" | "pull-request"
  ): Promise<RepositoryWorkItemEvidence[]> {
    const items: RepositoryWorkItemEvidence[] = [];
    for (const value of values) {
      const item = await this.#hydrateWorkItem(
        repositoryPath,
        value,
        gaps,
        signal,
        forcedKind
      );
      if (item) items.push(item);
    }
    return items;
  }

  async #attemptRepository(
    item: RepositoryInventoryItem,
    attempt: 1 | 2,
    signal: AbortSignal | undefined
  ): Promise<RepositoryAttempt> {
    const gaps: GitHubIngestionGap[] = [];
    const repositoryPath = `/repos/${encodeSegment(item.owner)}/${encodeSegment(item.name)}`;
    let metadataResult: GitHubReadResult<JsonRecord>;
    try {
      metadataResult = await this.#client.requestJson<JsonRecord>({
        path: repositoryPath,
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      const snapshot = minimalSnapshot(item, "incomplete", [errorGap(error, repositoryPath)]);
      snapshot.attempts = attempt;
      return { snapshot, moved: false };
    }
    if (metadataResult.kind !== "ok" && metadataResult.kind !== "not-modified") {
      const renamedTo = renamedFullName(metadataResult.gap.replacementUrl);
      const snapshot = minimalSnapshot(
        item,
        metadataResult.kind,
        [metadataResult.gap],
        renamedTo
      );
      snapshot.attempts = attempt;
      return { snapshot, moved: false };
    }
    const metadata = metadataResult.data;
    const fullName = stringValue(metadata.full_name) ?? item.fullName;
    if (fullName !== item.fullName) {
      const renamedGap = makeGap(
        "renamed",
        "renamed",
        repositoryPath,
        `Repository identity changed from ${item.fullName} to ${fullName}.`,
        200,
        metadataResult.url
      );
      const snapshot = minimalSnapshot(item, "renamed", [renamedGap], fullName);
      snapshot.attempts = attempt;
      return { snapshot, moved: false };
    }
    const defaultBranch = stringValue(metadata.default_branch) ?? item.defaultBranch;
    const visibility = visibilityValue(metadata.visibility, metadata.private);
    const beforeRef = await this.#fingerprint(
      repositoryPath,
      defaultBranch,
      gaps,
      signal
    );
    if (beforeRef === null) {
      const snapshot: RepositoryPortfolioSnapshot = {
        ...minimalSnapshot(item, "incomplete", gaps),
        attempts: attempt,
        visibility,
        defaultBranch
      };
      return { snapshot, moved: false };
    }

    const treePath = `${repositoryPath}/git/trees/${encodeSegment(beforeRef.treeSha)}?recursive=1`;
    const tree = await this.#readJson<JsonRecord>(treePath, gaps, signal);
    const treeTruncated = tree ? booleanValue(tree.truncated) ?? false : false;
    if (treeTruncated) {
      gaps.push(
        makeGap(
          "incomplete",
          "tree-truncated",
          treePath,
          "GitHub truncated the recursive tree; file evidence is incomplete."
        )
      );
    }
    const files = tree
      ? await this.#artifactFiles(
          repositoryPath,
          beforeRef.commitSha,
          tree,
          gaps,
          signal
        )
      : [];

    const releaseValues = await this.#readPages<unknown>(
      `${repositoryPath}/releases?per_page=100`,
      gaps,
      signal
    );
    const releases = releaseValues
      .map(parseRelease)
      .filter((entry): entry is RepositoryReleaseEvidence => entry !== null);

    const languagesValue = await this.#readJson<JsonRecord>(
      `${repositoryPath}/languages`,
      gaps,
      signal
    );
    const languages: Record<string, number> = {};
    if (languagesValue) {
      for (const [language, bytes] of Object.entries(languagesValue)) {
        const count = numberValue(bytes);
        if (count !== null && count >= 0) languages[language] = count;
      }
    }

    const topicsValue = await this.#readJson<JsonRecord>(
      `${repositoryPath}/topics`,
      gaps,
      signal
    );
    const metadataTopics = Array.isArray(metadata.topics)
      ? metadata.topics.filter((topic): topic is string => typeof topic === "string")
      : [];
    const topics = topicsValue && Array.isArray(topicsValue.names)
      ? topicsValue.names.filter((topic): topic is string => typeof topic === "string")
      : metadataTopics;

    const licenseValue = await this.#readJson<JsonRecord>(
      `${repositoryPath}/license`,
      gaps,
      signal,
      true
    );
    const licenseRecord = licenseValue
      ? nestedRecord(licenseValue, "license")
      : nestedRecord(metadata, "license");
    const license: RepositoryLicenseEvidence | undefined = licenseRecord
      ? {
          spdxId: stringValue(licenseRecord.spdx_id),
          name: stringValue(licenseRecord.name)
        }
      : undefined;

    const commitValues = await this.#readJson<unknown[]>(
      `${repositoryPath}/commits?sha=${encodeURIComponent(beforeRef.commitSha)}&per_page=${RECENT_COMMIT_LIMIT}`,
      gaps,
      signal
    );
    const recentCommits = (Array.isArray(commitValues) ? commitValues : [])
      .slice(0, RECENT_COMMIT_LIMIT)
      .map(parseCommit)
      .filter((entry): entry is RepositoryCommitEvidence => entry !== null);

    const openIssueValues = await this.#readPages<unknown>(
      `${repositoryPath}/issues?state=open&sort=updated&direction=desc&per_page=100`,
      gaps,
      signal
    );
    const openIssues = await this.#hydrateWorkItems(
      repositoryPath,
      openIssueValues.filter(
        (value) => !(isRecord(value) && isRecord(value.pull_request))
      ),
      gaps,
      signal,
      "issue"
    );

    const openPullValues = await this.#readPages<unknown>(
      `${repositoryPath}/pulls?state=open&sort=updated&direction=desc&per_page=100`,
      gaps,
      signal
    );
    const openPullRequests = await this.#hydrateWorkItems(
      repositoryPath,
      openPullValues,
      gaps,
      signal,
      "pull-request"
    );

    const closedValues = await this.#readJson<unknown[]>(
      `${repositoryPath}/issues?state=closed&sort=updated&direction=desc&per_page=${RECENT_CLOSED_WORK_ITEM_LIMIT}&page=1`,
      gaps,
      signal
    );
    const recentlyClosedWorkItems = await this.#hydrateWorkItems(
      repositoryPath,
      (Array.isArray(closedValues) ? closedValues : []).slice(
        0,
        RECENT_CLOSED_WORK_ITEM_LIMIT
      ),
      gaps,
      signal
    );

    const afterRef = await this.#fingerprint(
      repositoryPath,
      defaultBranch,
      gaps,
      signal
    );
    const moved =
      afterRef !== null &&
      (afterRef.commitSha !== beforeRef.commitSha ||
        afterRef.treeSha !== beforeRef.treeSha);
    if (moved && attempt === 2) {
      gaps.push(
        makeGap(
          "incomplete",
          "moving-head",
          repositoryPath,
          "The default branch moved again after the single permitted retry."
        )
      );
    }

    const snapshot: RepositoryPortfolioSnapshot = {
      requestedFullName: item.fullName,
      fullName,
      status: gaps.length === 0 ? "complete" : "incomplete",
      attempts: attempt,
      visibility,
      defaultBranch,
      beforeRef,
      ...(afterRef ? { afterRef } : {}),
      treeSha: beforeRef.treeSha,
      treeTruncated,
      files,
      releases,
      languages,
      topics,
      ...(license ? { license } : {}),
      recentCommits,
      openIssues,
      openPullRequests,
      recentlyClosedWorkItems,
      gaps
    };
    return { snapshot, moved };
  }

  async #ingestRepository(
    item: RepositoryInventoryItem,
    signal: AbortSignal | undefined
  ): Promise<{ snapshot: RepositoryPortfolioSnapshot; warnings: string[] }> {
    const first = await this.#attemptRepository(item, 1, signal);
    if (!first.moved) return { snapshot: first.snapshot, warnings: [] };
    const warning = `${item.fullName} moved during ingestion; retried once.`;
    const second = await this.#attemptRepository(item, 2, signal);
    return { snapshot: second.snapshot, warnings: [warning] };
  }

  async ingestOwnedPortfolio(
    options: PortfolioIngestionOptions = {}
  ): Promise<PortfolioIngestionResult> {
    const startedAt = this.#now().toISOString();
    let checkpoint: PortfolioIngestionCheckpoint;
    if (options.checkpoint) {
      checkpoint = {
        schemaVersion: "portfolio-ingestion-checkpoint/v1",
        inventory: [...options.checkpoint.inventory],
        inventoryComplete: options.checkpoint.inventoryComplete,
        inventoryGaps: [...options.checkpoint.inventoryGaps],
        nextRepositoryIndex: options.checkpoint.nextRepositoryIndex,
        repositories: [...options.checkpoint.repositories]
      };
    } else {
      const inventory = await this.#ownedInventory(options.signal);
      checkpoint = {
        schemaVersion: "portfolio-ingestion-checkpoint/v1",
        inventory: inventory.items,
        inventoryComplete: inventory.complete,
        inventoryGaps: inventory.gaps,
        nextRepositoryIndex: 0,
        repositories: []
      };
      if (options.onCheckpoint) await options.onCheckpoint(checkpoint);
    }
    if (
      !Number.isSafeInteger(checkpoint.nextRepositoryIndex) ||
      checkpoint.nextRepositoryIndex < 0 ||
      checkpoint.nextRepositoryIndex > checkpoint.inventory.length ||
      checkpoint.repositories.length !== checkpoint.nextRepositoryIndex
    ) {
      throw new TypeError("Portfolio ingestion checkpoint is internally inconsistent.");
    }

    const warnings: string[] = [];
    for (
      let index = checkpoint.nextRepositoryIndex;
      index < checkpoint.inventory.length;
      index += 1
    ) {
      const item = checkpoint.inventory[index];
      if (!item) break;
      const result = await this.#ingestRepository(item, options.signal);
      checkpoint.repositories.push(result.snapshot);
      checkpoint.nextRepositoryIndex = index + 1;
      warnings.push(...result.warnings);
      if (options.onCheckpoint) {
        await options.onCheckpoint({
          ...checkpoint,
          inventory: [...checkpoint.inventory],
          inventoryGaps: [...checkpoint.inventoryGaps],
          repositories: [...checkpoint.repositories]
        });
      }
    }

    const repositories = [...checkpoint.repositories];
    const gaps = [
      ...checkpoint.inventoryGaps,
      ...repositories.flatMap((repository) => repository.gaps)
    ];
    return {
      startedAt,
      completedAt: this.#now().toISOString(),
      inventory: [...checkpoint.inventory],
      inventoryComplete: checkpoint.inventoryComplete,
      repositories,
      gaps,
      warnings,
      checkpoint: {
        ...checkpoint,
        inventory: [...checkpoint.inventory],
        inventoryGaps: [...checkpoint.inventoryGaps],
        repositories
      }
    };
  }
}
