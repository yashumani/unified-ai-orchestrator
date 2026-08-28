import {
  SCHEMA_VERSION,
  TrustGrantSchema,
  UtcTimestampSchema,
  WorkspaceIdentitySchema,
  type DevelopmentBranchPattern,
  type PolicyErrorCode,
  type TrustGrant,
  type WorkspaceIdentity
} from "@unified-ai/contracts";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  DEFAULT_DEVELOPMENT_BRANCH_PATTERNS,
  isPathInsideOrEqual,
  isProtectedBranch,
  matchesDevelopmentBranch,
  pathsReferToSameLocation
} from "./workspace-identity.js";

const DEFAULT_GRANT_RELATIVE_PATH = ".local/trust/workspace-grant.json";
const MAX_GRANT_BYTES = 64 * 1024;

export type TrustDocumentStatus = "active" | "revoked";

export interface StoredTrustDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  status: TrustDocumentStatus;
  grant: TrustGrant;
  revokedAt?: string;
}

export interface TrustCheck {
  trusted: boolean;
  code: Extract<
    PolicyErrorCode,
    | "allowed"
    | "workspace_untrusted"
    | "repository_mismatch"
    | "origin_mismatch"
    | "protected_branch"
    | "branch_not_allowed"
  >;
  reason: string;
  grant: TrustGrant | null;
}

export interface TrustStoreOptions {
  repositoryRoot: string;
  grantRelativePath?: string;
  now?: () => Date;
}

export class TrustStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TrustStoreError";
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function parseStoredTrustDocument(value: unknown): StoredTrustDocument {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, [
      "schemaVersion",
      "status",
      "grant"
    ], ["revokedAt"])
  ) {
    throw new TrustStoreError("Trust document has an invalid shape.");
  }

  const object = value as Record<string, unknown>;
  if (object.schemaVersion !== SCHEMA_VERSION) {
    throw new TrustStoreError("Trust document schema version is unsupported.");
  }
  if (object.status !== "active" && object.status !== "revoked") {
    throw new TrustStoreError("Trust document status is invalid.");
  }

  const grant = TrustGrantSchema.parse(object.grant);
  if (object.status === "active" && object.revokedAt !== undefined) {
    throw new TrustStoreError("An active trust document cannot have revokedAt.");
  }
  if (object.status === "revoked") {
    if (typeof object.revokedAt !== "string") {
      throw new TrustStoreError("A revoked trust document requires revokedAt.");
    }
    UtcTimestampSchema.parse(object.revokedAt);
  }

  return object.status === "active"
    ? {
        schemaVersion: SCHEMA_VERSION,
        status: "active",
        grant
      }
    : {
        schemaVersion: SCHEMA_VERSION,
        status: "revoked",
        grant,
        revokedAt: object.revokedAt as string
      };
}

function isInsideLexically(root: string, target: string): boolean {
  const difference = relative(root, target);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) &&
      difference !== ".." &&
      !isAbsolute(difference))
  );
}

function safeGrantRelativePath(value: string): string[] {
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith("\\\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TrustStoreError("Trust grant path must be repository-relative.");
  }

  const segments = value.replace(/\\/gu, "/").split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new TrustStoreError("Trust grant path contains an unsafe component.");
  }
  return segments;
}

export class TrustStore {
  readonly #repositoryRoot: string;
  readonly #grantRelativePath: string;
  readonly #now: () => Date;

  public constructor(options: TrustStoreOptions) {
    this.#repositoryRoot = resolve(options.repositoryRoot);
    this.#grantRelativePath =
      options.grantRelativePath ?? DEFAULT_GRANT_RELATIVE_PATH;
    safeGrantRelativePath(this.#grantRelativePath);
    this.#now = options.now ?? (() => new Date());
  }

  public get configuredGrantPath(): string {
    return resolve(this.#repositoryRoot, ...safeGrantRelativePath(this.#grantRelativePath));
  }

  async #canonicalRoot(): Promise<string> {
    try {
      return await realpath(this.#repositoryRoot);
    } catch {
      throw new TrustStoreError("Canonical repository root is unavailable.");
    }
  }

  async #grantLocation(createDirectory: boolean): Promise<{
    canonicalRoot: string;
    directory: string;
    file: string;
  }> {
    const canonicalRoot = await this.#canonicalRoot();
    const segments = safeGrantRelativePath(this.#grantRelativePath);
    const fileName = segments.at(-1);
    if (fileName === undefined) {
      throw new TrustStoreError("Trust grant filename is missing.");
    }

    let current = canonicalRoot;
    for (const segment of segments.slice(0, -1)) {
      const next = resolve(current, segment);
      if (!isInsideLexically(canonicalRoot, next)) {
        throw new TrustStoreError("Trust grant directory escapes the repository.");
      }

      try {
        const status = await lstat(next);
        if (status.isSymbolicLink() || !status.isDirectory()) {
          throw new TrustStoreError(
            "Trust grant directory cannot traverse a symlink or non-directory."
          );
        }
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT" &&
          createDirectory
        ) {
          await mkdir(next);
        } else if (error instanceof TrustStoreError) {
          throw error;
        } else if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return { canonicalRoot, directory: dirname(next), file: resolve(next, fileName) };
        } else {
          throw new TrustStoreError("Trust grant directory cannot be inspected.");
        }
      }

      const resolvedDirectory = await realpath(next);
      if (!isPathInsideOrEqual(canonicalRoot, resolvedDirectory)) {
        throw new TrustStoreError("Trust grant directory resolves outside the repository.");
      }
      current = resolvedDirectory;
    }

    const file = resolve(current, fileName);
    if (!isInsideLexically(canonicalRoot, file)) {
      throw new TrustStoreError("Trust grant file escapes the repository.");
    }
    return { canonicalRoot, directory: current, file };
  }

  public async read(): Promise<StoredTrustDocument | null> {
    const location = await this.#grantLocation(false);
    let status;
    try {
      status = await lstat(location.file);
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return null;
      }
      throw new TrustStoreError("Trust grant file cannot be inspected.");
    }

    if (status.isSymbolicLink() || !status.isFile()) {
      throw new TrustStoreError("Trust grant file must be a regular file.");
    }
    if (status.size > MAX_GRANT_BYTES) {
      throw new TrustStoreError("Trust grant file is unexpectedly large.");
    }

    const resolvedFile = await realpath(location.file);
    if (!isPathInsideOrEqual(location.canonicalRoot, resolvedFile)) {
      throw new TrustStoreError("Trust grant file resolves outside the repository.");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(resolvedFile, "utf8"));
    } catch {
      throw new TrustStoreError("Trust grant file is not valid JSON.");
    }
    try {
      return parseStoredTrustDocument(parsed);
    } catch (error: unknown) {
      if (error instanceof TrustStoreError) {
        throw error;
      }
      throw new TrustStoreError("Trust grant file failed schema validation.");
    }
  }

  async #write(document: StoredTrustDocument): Promise<void> {
    const parsed = parseStoredTrustDocument(document);
    const location = await this.#grantLocation(true);

    try {
      const existing = await lstat(location.file);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new TrustStoreError("Existing trust grant is not a regular file.");
      }
    } catch (error: unknown) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        if (error instanceof TrustStoreError) {
          throw error;
        }
        throw new TrustStoreError("Existing trust grant cannot be inspected.");
      }
    }

    const temporary = resolve(
      location.directory,
      `.workspace-grant.${process.pid}.${randomUUID()}.tmp`
    );
    const contents = `${JSON.stringify(parsed, null, 2)}\n`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;

      const resolvedDirectory = await realpath(location.directory);
      if (!isPathInsideOrEqual(location.canonicalRoot, resolvedDirectory)) {
        throw new TrustStoreError("Trust grant directory changed during write.");
      }
      await rename(temporary, location.file);
    } catch (error: unknown) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof TrustStoreError) {
        throw error;
      }
      throw new TrustStoreError("Trust grant could not be written atomically.");
    }
  }

  public async grant(identityInput: WorkspaceIdentity): Promise<TrustGrant> {
    const identity = WorkspaceIdentitySchema.parse(identityInput);
    const canonicalRoot = await this.#canonicalRoot();
    if (!pathsReferToSameLocation(canonicalRoot, identity.repositoryRoot)) {
      throw new TrustStoreError("Workspace identity does not match the trust store root.");
    }
    if (isProtectedBranch(identity.branch)) {
      throw new TrustStoreError("Persistent trust cannot be granted on a protected branch.");
    }
    if (!matchesDevelopmentBranch(identity.branch)) {
      throw new TrustStoreError("Persistent trust requires an allowed development branch.");
    }

    const branchPatterns: DevelopmentBranchPattern[] = [
      ...DEFAULT_DEVELOPMENT_BRANCH_PATTERNS
    ];
    const grant = TrustGrantSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      grantId: `workspace-${identity.originSha256.slice(0, 16)}`,
      repositoryRoot: canonicalRoot,
      originSha256: identity.originSha256,
      branchPatterns,
      grantedAt: this.#now().toISOString(),
      permanent: true
    });

    await this.#write({
      schemaVersion: SCHEMA_VERSION,
      status: "active",
      grant
    });
    return grant;
  }

  public async revoke(): Promise<StoredTrustDocument | null> {
    const existing = await this.read();
    if (existing === null || existing.status === "revoked") {
      return existing;
    }

    const revoked: StoredTrustDocument = {
      schemaVersion: SCHEMA_VERSION,
      status: "revoked",
      grant: existing.grant,
      revokedAt: this.#now().toISOString()
    };
    await this.#write(revoked);
    return revoked;
  }

  public async check(identity: WorkspaceIdentity): Promise<TrustCheck> {
    if (isProtectedBranch(identity.branch)) {
      return {
        trusted: false,
        code: "protected_branch",
        reason: `Branch ${identity.branch} is always protected.`,
        grant: null
      };
    }

    let document: StoredTrustDocument | null;
    try {
      document = await this.read();
    } catch {
      return {
        trusted: false,
        code: "workspace_untrusted",
        reason: "The persistent trust document is missing, unreadable, or invalid.",
        grant: null
      };
    }

    if (document === null || document.status !== "active") {
      return {
        trusted: false,
        code: "workspace_untrusted",
        reason: "No active persistent workspace grant exists.",
        grant: null
      };
    }
    if (!pathsReferToSameLocation(document.grant.repositoryRoot, identity.repositoryRoot)) {
      return {
        trusted: false,
        code: "repository_mismatch",
        reason: "Current repository root does not match the persistent grant.",
        grant: null
      };
    }
    if (document.grant.originSha256 !== identity.originSha256) {
      return {
        trusted: false,
        code: "origin_mismatch",
        reason: "Current Git origin does not match the persistent grant.",
        grant: null
      };
    }
    if (!matchesDevelopmentBranch(identity.branch, document.grant.branchPatterns)) {
      return {
        trusted: false,
        code: "branch_not_allowed",
        reason: `Branch ${identity.branch} is outside the persistent grant.`,
        grant: null
      };
    }

    return {
      trusted: true,
      code: "allowed",
      reason: "Persistent workspace trust is active and matches current Git identity.",
      grant: document.grant
    };
  }
}
