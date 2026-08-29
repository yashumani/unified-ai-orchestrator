// Package-local integration boundary. Lane A can map these shapes to
// RepositoryEvidenceRecord, PortfolioRunCheckpoint, PortfolioRunError,
// RepositorySnapshot, and RepositoryProfile without coupling this adapter to
// shared contracts while those schemas are landing.

export type GitHubReadMethod = "GET" | "HEAD";

export interface GitHubCredentialProvider {
  getToken(): Promise<string | undefined>;
}

export interface GitHubRateLimit {
  limit: number | null;
  remaining: number | null;
  used: number | null;
  resetAt: string | null;
  resource: string | null;
}

export interface GitHubLinks {
  next: string | null;
  previous: string | null;
  first: string | null;
  last: string | null;
}

export type GitHubGapKind =
  | "renamed"
  | "deleted"
  | "permission-gap"
  | "incomplete";

export type GitHubGapReason =
  | "renamed"
  | "deleted"
  | "not-found"
  | "permission-denied"
  | "rate-limited"
  | "tree-truncated"
  | "artifact-limit"
  | "artifact-unavailable"
  | "invalid-response"
  | "moving-head"
  | "pagination-limit"
  | "etag-cache-miss"
  | "network-error";

export interface GitHubIngestionGap {
  kind: GitHubGapKind;
  reason: GitHubGapReason;
  url: string;
  status: number | null;
  detail: string;
  replacementUrl: string | null;
  retryAfterMs: number | null;
}

export interface GitHubReadRequest {
  path: string;
  method?: GitHubReadMethod;
  accept?: string;
  signal?: AbortSignal;
}

export interface GitHubReadMetadata {
  status: number;
  url: string;
  etag: string | null;
  links: GitHubLinks;
  rateLimit: GitHubRateLimit | null;
  retryAfterMs: number | null;
}

export interface GitHubReadOk<T> extends GitHubReadMetadata {
  kind: "ok";
  data: T;
}

export interface GitHubReadNotModified<T> extends GitHubReadMetadata {
  kind: "not-modified";
  data: T;
}

export type GitHubReadSuccess<T> = GitHubReadOk<T> | GitHubReadNotModified<T>;

export interface GitHubReadGap extends GitHubReadMetadata {
  kind: GitHubGapKind;
  gap: GitHubIngestionGap;
}

export type GitHubReadResult<T> =
  | GitHubReadOk<T>
  | GitHubReadNotModified<T>
  | GitHubReadGap;

export interface GitHubEtagCacheEntry<T = unknown> {
  etag: string;
  data: T;
  linkHeader: string | null;
}

export interface GitHubEtagCache {
  get<T>(url: string): Promise<GitHubEtagCacheEntry<T> | undefined>;
  set<T>(url: string, entry: GitHubEtagCacheEntry<T>): Promise<void>;
}

export interface PaginationCheckpoint<T> {
  items: T[];
  nextUrl: string | null;
  pagesRead: number;
}

export interface GitHubPaginationRequest<T> {
  path: string;
  checkpoint?: PaginationCheckpoint<T>;
  maxPages?: number;
  signal?: AbortSignal;
  onCheckpoint?: (
    checkpoint: PaginationCheckpoint<T>
  ) => void | Promise<void>;
}

export interface GitHubPaginationResult<T> {
  items: T[];
  complete: boolean;
  nextUrl: string | null;
  pagesRead: number;
  gaps: GitHubIngestionGap[];
  rateLimits: GitHubRateLimit[];
}

export interface GitHubClientEvent {
  method: GitHubReadMethod;
  url: string;
  status: number | null;
  outcome:
    | "ok"
    | "not-modified"
    | "renamed"
    | "deleted"
    | "permission-gap"
    | "incomplete"
    | "error";
  rateLimit: GitHubRateLimit | null;
  retryAfterMs: number | null;
}

export type GitHubVisibility = "public" | "private" | "internal" | "unknown";

export interface RepositoryInventoryItem {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  visibility: GitHubVisibility;
  defaultBranch: string;
  archived: boolean;
  fork: boolean;
  updatedAt: string | null;
}

export interface GitRefFingerprint {
  branch: string;
  commitSha: string;
  treeSha: string;
  observedAt: string;
}

export type RepositoryArtifactKind =
  | "readme"
  | "documentation"
  | "manifest"
  | "workflow"
  | "deployment";

export interface RepositoryFileEvidence {
  path: string;
  kind: RepositoryArtifactKind;
  sha: string | null;
  size: number | null;
  content: string | null;
  encoding: string | null;
  complete: boolean;
}

export interface RepositoryLicenseEvidence {
  spdxId: string | null;
  name: string | null;
}

export interface RepositoryReleaseEvidence {
  id: number;
  tagName: string;
  name: string | null;
  publishedAt: string | null;
  draft: boolean;
  prerelease: boolean;
}

export interface RepositoryCommitEvidence {
  sha: string;
  message: string;
  authoredAt: string | null;
  committedAt: string | null;
  authorLogin: string | null;
}

export interface RepositoryCommentEvidence {
  id: number;
  body: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  authorLogin: string | null;
}

export interface RepositoryReviewEvidence extends RepositoryCommentEvidence {
  state: string | null;
  submittedAt: string | null;
  commitId: string | null;
}

export interface RepositoryWorkItemEvidence {
  id: number;
  number: number;
  kind: "issue" | "pull-request";
  title: string;
  state: "open" | "closed";
  updatedAt: string | null;
  createdAt: string | null;
  closedAt: string | null;
  authorLogin: string | null;
  headSha: string | null;
  baseSha: string | null;
  comments: RepositoryCommentEvidence[];
  reviews: RepositoryReviewEvidence[];
  reviewComments: RepositoryCommentEvidence[];
}

export type RepositoryIngestionStatus =
  | "complete"
  | "renamed"
  | "deleted"
  | "permission-gap"
  | "incomplete";

export interface RepositoryPortfolioSnapshot {
  requestedFullName: string;
  fullName: string;
  status: RepositoryIngestionStatus;
  renamedTo?: string;
  attempts: 1 | 2;
  visibility?: GitHubVisibility;
  defaultBranch?: string;
  beforeRef?: GitRefFingerprint;
  afterRef?: GitRefFingerprint;
  treeSha?: string;
  treeTruncated?: boolean;
  files: RepositoryFileEvidence[];
  releases: RepositoryReleaseEvidence[];
  languages: Record<string, number>;
  topics: string[];
  license?: RepositoryLicenseEvidence;
  recentCommits: RepositoryCommitEvidence[];
  openIssues: RepositoryWorkItemEvidence[];
  openPullRequests: RepositoryWorkItemEvidence[];
  recentlyClosedWorkItems: RepositoryWorkItemEvidence[];
  gaps: GitHubIngestionGap[];
}

export interface PortfolioIngestionCheckpoint {
  schemaVersion: "portfolio-ingestion-checkpoint/v1";
  inventory: RepositoryInventoryItem[];
  inventoryComplete: boolean;
  inventoryGaps: GitHubIngestionGap[];
  nextRepositoryIndex: number;
  repositories: RepositoryPortfolioSnapshot[];
}

export interface PortfolioIngestionOptions {
  checkpoint?: PortfolioIngestionCheckpoint;
  signal?: AbortSignal;
  onCheckpoint?: (
    checkpoint: PortfolioIngestionCheckpoint
  ) => void | Promise<void>;
}

export interface PortfolioIngestionResult {
  startedAt: string;
  completedAt: string;
  inventory: RepositoryInventoryItem[];
  inventoryComplete: boolean;
  repositories: RepositoryPortfolioSnapshot[];
  gaps: GitHubIngestionGap[];
  warnings: string[];
  checkpoint: PortfolioIngestionCheckpoint;
}
