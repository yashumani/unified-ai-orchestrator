import {
  PolicyDecisionSchema,
  RepositoryToolNameSchema,
  type PolicyDecision,
  type PolicyErrorCode,
  type RepositoryToolName,
  type TrustGrant,
  type TrustState,
  type WorkspaceIdentity
} from "@unified-ai/contracts";
import { resolveMutationPath, PathPolicyError } from "./path-policy.js";
import { TrustStore, TrustStoreError } from "./trust-store.js";
import {
  isProtectedBranch,
  matchesDevelopmentBranch,
  resolveWorkspaceIdentity,
  WorkspaceIdentityError
} from "./workspace-identity.js";

const MUTATING_REPOSITORY_TOOLS = new Set<RepositoryToolName>([
  "repository.write_file",
  "repository.replace_text",
  "repository.create_directory",
  "repository.run_npm_script"
]);

const PATH_MUTATION_TOOLS = new Set<RepositoryToolName>([
  "repository.write_file",
  "repository.replace_text",
  "repository.create_directory"
]);

export interface MutationPolicyRequest {
  toolName: string;
  repositoryRelativePath?: string;
}

export interface MutationAuthorization {
  decision: PolicyDecision;
  identity: WorkspaceIdentity | null;
  grant: TrustGrant | null;
  resolvedPath: string | null;
}

export interface PolicyEngineOptions {
  repositoryRoot: string;
  grantRelativePath?: string;
  now?: () => Date;
}

export class PolicyDeniedError extends Error {
  public readonly decision: PolicyDecision;

  public constructor(decision: PolicyDecision) {
    super(decision.reason);
    this.name = "PolicyDeniedError";
    this.decision = decision;
  }
}

export class PolicyEngine {
  readonly #repositoryRoot: string;
  readonly #trustStore: TrustStore;
  readonly #now: () => Date;

  public constructor(options: PolicyEngineOptions) {
    this.#repositoryRoot = options.repositoryRoot;
    this.#now = options.now ?? (() => new Date());
    this.#trustStore = new TrustStore({
      repositoryRoot: options.repositoryRoot,
      ...(options.grantRelativePath === undefined
        ? {}
        : { grantRelativePath: options.grantRelativePath }),
      now: this.#now
    });
  }

  public get configuredGrantPath(): string {
    return this.#trustStore.configuredGrantPath;
  }

  #decision(
    allowed: boolean,
    code: PolicyErrorCode,
    reason: string
  ): PolicyDecision {
    return PolicyDecisionSchema.parse({
      allowed,
      code,
      reason,
      checkedAt: this.#now().toISOString()
    });
  }

  #blocked(
    code: Exclude<PolicyErrorCode, "allowed">,
    reason: string,
    identity: WorkspaceIdentity | null = null
  ): MutationAuthorization {
    return {
      decision: this.#decision(false, code, reason),
      identity,
      grant: null,
      resolvedPath: null
    };
  }

  async #identity(): Promise<WorkspaceIdentity> {
    return resolveWorkspaceIdentity(this.#repositoryRoot);
  }

  public async getTrustState(): Promise<TrustState> {
    const identity = await this.#identity();
    const check = await this.#trustStore.check(identity);
    return {
      trusted: check.trusted,
      identity,
      grant: check.grant,
      reason: check.reason
    };
  }

  /** Local API authority only. This method is never part of the model tool set. */
  public async grantWorkspaceTrust(): Promise<TrustState> {
    const identity = await this.#identity();
    await this.#trustStore.grant(identity);
    return this.getTrustState();
  }

  /** Local API authority only. This method is never part of the model tool set. */
  public async revokeWorkspaceTrust(): Promise<TrustState> {
    await this.#trustStore.revoke();
    return this.getTrustState();
  }

  public async evaluateMutation(
    request: MutationPolicyRequest
  ): Promise<MutationAuthorization> {
    let identity: WorkspaceIdentity;
    try {
      identity = await this.#identity();
    } catch (error: unknown) {
      if (error instanceof WorkspaceIdentityError) {
        return this.#blocked(error.code, error.message);
      }
      return this.#blocked(
        "repository_mismatch",
        "Workspace identity could not be revalidated."
      );
    }

    const parsedTool = RepositoryToolNameSchema.safeParse(request.toolName);
    if (!parsedTool.success || !MUTATING_REPOSITORY_TOOLS.has(parsedTool.data)) {
      return this.#blocked(
        "tool_not_allowed",
        `Tool ${request.toolName} is not an allowed mutation tool.`,
        identity
      );
    }

    if (isProtectedBranch(identity.branch)) {
      return this.#blocked(
        "protected_branch",
        `Branch ${identity.branch} is always protected.`,
        identity
      );
    }
    if (!matchesDevelopmentBranch(identity.branch)) {
      return this.#blocked(
        "branch_not_allowed",
        `Branch ${identity.branch} is not an allowed development branch.`,
        identity
      );
    }

    const trust = await this.#trustStore.check(identity);
    if (!trust.trusted || trust.grant === null) {
      return this.#blocked(
        trust.code === "allowed" ? "workspace_untrusted" : trust.code,
        trust.reason,
        identity
      );
    }

    let resolvedPath: string;
    try {
      if (PATH_MUTATION_TOOLS.has(parsedTool.data)) {
        if (request.repositoryRelativePath === undefined) {
          return this.#blocked(
            "invalid_input",
            `Tool ${parsedTool.data} requires a repository-relative path.`,
            identity
          );
        }
        resolvedPath = await resolveMutationPath(
          identity.repositoryRoot,
          request.repositoryRelativePath
        );
      } else {
        if (request.repositoryRelativePath !== undefined) {
          return this.#blocked(
            "invalid_input",
            `Tool ${parsedTool.data} does not accept a repository path.`,
            identity
          );
        }
        resolvedPath = await resolveMutationPath(
          identity.repositoryRoot,
          "package.json"
        );
      }
    } catch (error: unknown) {
      if (error instanceof PathPolicyError) {
        return this.#blocked(error.code, error.message, identity);
      }
      return this.#blocked(
        "path_escape",
        "Mutation path could not be revalidated safely.",
        identity
      );
    }

    return {
      decision: this.#decision(
        true,
        "allowed",
        "Mutation is allowed by active workspace trust and current repository policy."
      ),
      identity,
      grant: trust.grant,
      resolvedPath
    };
  }

  public async assertMutationAllowed(
    request: MutationPolicyRequest
  ): Promise<MutationAuthorization> {
    const authorization = await this.evaluateMutation(request);
    if (!authorization.decision.allowed) {
      throw new PolicyDeniedError(authorization.decision);
    }
    return authorization;
  }
}

export function isMutationTool(toolName: string): toolName is RepositoryToolName {
  const parsed = RepositoryToolNameSchema.safeParse(toolName);
  return parsed.success && MUTATING_REPOSITORY_TOOLS.has(parsed.data);
}

export { TrustStoreError };
