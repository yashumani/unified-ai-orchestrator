import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "expected a lowercase SHA-256 hex digest");

export const StableIdSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
    "expected a lowercase kebab-case identifier"
  );

export const UtcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "expected an ISO-8601 UTC timestamp");

export const SourceTypeSchema = z.enum([
  "chatgpt-conversation",
  "github-repository",
  "local-repository",
  "test-run",
  "deployment"
]);

export const SourceReferenceSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    sourceId: StableIdSchema,
    sourceType: SourceTypeSchema,
    capturedAt: UtcTimestampSchema,
    contentSha256: Sha256Schema,
    locator: z.record(z.string().min(1), z.string().min(1)).optional()
  })
  .strict();

export const ConversationActorSchema = z.enum([
  "user",
  "assistant",
  "tool",
  "system"
]);

export const ConversationTurnSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    turnId: StableIdSchema,
    actor: ConversationActorSchema,
    occurredAt: UtcTimestampSchema,
    content: z.string().min(1)
  })
  .strict();

export const ConversationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    sourceSystem: z.literal("chatgpt"),
    projectId: StableIdSchema,
    conversationId: StableIdSchema,
    title: z.string().min(1),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    turns: z.array(ConversationTurnSchema).min(1)
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (Date.parse(snapshot.updatedAt) < Date.parse(snapshot.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "updatedAt must not precede createdAt",
        path: ["updatedAt"]
      });
    }

    const turnIds = new Set<string>();
    for (const [index, turn] of snapshot.turns.entries()) {
      if (turnIds.has(turn.turnId)) {
        context.addIssue({
          code: "custom",
          message: "turnId values must be unique",
          path: ["turns", index, "turnId"]
        });
      }
      turnIds.add(turn.turnId);
    }
  });

export const EvidenceEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    evidenceId: StableIdSchema,
    capturedAt: UtcTimestampSchema,
    mediaType: z.string().min(1),
    source: SourceReferenceSchema,
    payload: z.unknown()
  })
  .strict();

export const ReconciliationStatusSchema = z.enum([
  "unverified",
  "verified",
  "contradicted",
  "obsolete",
  "not-applicable"
]);

export const ClaimTypeSchema = z.enum([
  "requirement",
  "decision",
  "implementation",
  "validation",
  "deployment"
]);

export const ClaimRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    claimId: StableIdSchema,
    claimType: ClaimTypeSchema,
    assertedBy: ConversationActorSchema,
    statement: z.string().min(1),
    status: ReconciliationStatusSchema.default("unverified"),
    source: SourceReferenceSchema,
    evidenceObjectSha256: Sha256Schema
  })
  .strict();

export const ReceiptOutcomeSchema = z.enum(["succeeded", "failed", "paused"]);

export const EvidenceReceiptSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    receiptId: StableIdSchema,
    operation: StableIdSchema,
    startedAt: UtcTimestampSchema,
    completedAt: UtcTimestampSchema,
    inputObjectSha256: z.array(Sha256Schema).min(1),
    claimIds: z.array(StableIdSchema),
    outcome: ReceiptOutcomeSchema,
    warnings: z.array(z.string().min(1)).default([])
  })
  .strict()
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
      context.addIssue({
        code: "custom",
        message: "completedAt must not precede startedAt",
        path: ["completedAt"]
      });
    }
  });

export const CapturedRevisionSchema = z
  .string()
  .regex(
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u,
    "expected a lowercase full Git revision"
  );

export const EvidenceFamilySchema = z.enum([
  "identity",
  "default-branch",
  "documentation",
  "manifests",
  "workflows",
  "releases",
  "commits",
  "work-items"
]);

export const RepositoryEvidenceBindingSchema = z
  .object({
    repositoryId: StableIdSchema,
    capturedRevision: CapturedRevisionSchema,
    capturedAt: UtcTimestampSchema,
    evidenceObjectSha256: Sha256Schema
  })
  .strict();

export const RepositoryEvidenceRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    evidenceId: StableIdSchema,
    family: EvidenceFamilySchema,
    ...RepositoryEvidenceBindingSchema.shape,
    summary: z.string().min(1).max(10_000),
    locator: z.string().min(1).max(2_000).optional()
  })
  .strict();

function addUniqueValueIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message, path: [...path] });
  }
}

function validateUniqueRepositoryBindings(
  bindings: readonly { repositoryId: string }[],
  context: z.RefinementCtx
): void {
  addUniqueValueIssue(
    bindings.map((binding) => binding.repositoryId),
    context,
    ["repositories"],
    "repositoryId values must be unique"
  );
}

export const RepositorySnapshotSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    snapshotId: StableIdSchema,
    ...RepositoryEvidenceBindingSchema.shape,
    evidence: z.array(RepositoryEvidenceRecordSchema).length(8)
  })
  .strict()
  .superRefine((snapshot, context) => {
    const families = snapshot.evidence.map((record) => record.family);
    addUniqueValueIssue(
      families,
      context,
      ["evidence"],
      "snapshot evidence families must be unique"
    );
    if (new Set(families).size !== EvidenceFamilySchema.options.length) {
      context.addIssue({
        code: "custom",
        message: "snapshot must contain every required evidence family",
        path: ["evidence"]
      });
    }
    addUniqueValueIssue(
      snapshot.evidence.map((record) => record.evidenceId),
      context,
      ["evidence"],
      "snapshot evidenceId values must be unique"
    );
    for (const [index, record] of snapshot.evidence.entries()) {
      if (
        record.repositoryId !== snapshot.repositoryId ||
        record.capturedRevision !== snapshot.capturedRevision
      ) {
        context.addIssue({
          code: "custom",
          message: "evidence must match the snapshot repository and revision",
          path: ["evidence", index]
        });
      }
    }
  });

export const RepositoryProfileSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    profileId: StableIdSchema,
    snapshotId: StableIdSchema,
    ...RepositoryEvidenceBindingSchema.shape,
    name: z.string().min(1).max(500),
    summary: z.string().min(1).max(10_000),
    purposes: z.array(z.string().min(1).max(500)).max(50).default([]),
    capabilities: z.array(z.string().min(1).max(500)).max(100).default([]),
    technologyTags: z.array(z.string().min(1).max(200)).max(100).default([]),
    citationIds: z.array(StableIdSchema).min(1).max(500)
  })
  .strict()
  .superRefine((profile, context) => {
    addUniqueValueIssue(
      profile.citationIds,
      context,
      ["citationIds"],
      "citationId values must be unique"
    );
  });

export const RepositoryCitationSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    citationId: StableIdSchema,
    family: EvidenceFamilySchema,
    ...RepositoryEvidenceBindingSchema.shape,
    locator: z.string().min(1).max(2_000),
    statement: z.string().min(1).max(10_000)
  })
  .strict();

export const PortfolioRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "deferred"
]);

export const PortfolioRunSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    runId: StableIdSchema,
    createdAt: UtcTimestampSchema,
    evidenceObjectSha256: Sha256Schema,
    repositories: z.array(RepositoryEvidenceBindingSchema).min(1).max(100)
  })
  .strict()
  .superRefine((run, context) => {
    validateUniqueRepositoryBindings(run.repositories, context);
  });

export const PortfolioRunErrorSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    errorId: StableIdSchema,
    runId: StableIdSchema,
    code: StableIdSchema,
    message: z.string().min(1).max(10_000),
    retryable: z.boolean(),
    occurredAt: UtcTimestampSchema,
    evidenceObjectSha256: Sha256Schema,
    repository: RepositoryEvidenceBindingSchema.optional()
  })
  .strict();

export const PortfolioRunCheckpointSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    checkpointId: StableIdSchema,
    runId: StableIdSchema,
    sequence: z.number().int().nonnegative(),
    status: PortfolioRunStatusSchema,
    occurredAt: UtcTimestampSchema,
    evidenceObjectSha256: Sha256Schema,
    repositories: z.array(RepositoryEvidenceBindingSchema).min(1).max(100),
    errors: z.array(PortfolioRunErrorSchema).max(100).default([])
  })
  .strict()
  .superRefine((checkpoint, context) => {
    validateUniqueRepositoryBindings(checkpoint.repositories, context);
    addUniqueValueIssue(
      checkpoint.errors.map((error) => error.errorId),
      context,
      ["errors"],
      "errorId values must be unique"
    );
    for (const [index, error] of checkpoint.errors.entries()) {
      if (error.runId !== checkpoint.runId) {
        context.addIssue({
          code: "custom",
          message: "errors must identify the checkpoint run",
          path: ["errors", index, "runId"]
        });
      }
      if (
        error.repository !== undefined &&
        !checkpoint.repositories.some(
          (binding) =>
            binding.repositoryId === error.repository?.repositoryId &&
            binding.capturedRevision === error.repository.capturedRevision
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "error repository must belong to the checkpoint repository set",
          path: ["errors", index, "repository"]
        });
      }
    }
  });

export const OverlapClusterSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    clusterId: StableIdSchema,
    createdAt: UtcTimestampSchema,
    evidenceObjectSha256: Sha256Schema,
    label: z.string().min(1).max(500),
    rationale: z.string().min(1).max(10_000),
    sharedCapabilities: z.array(z.string().min(1).max(500)).min(1).max(100),
    repositories: z.array(RepositoryEvidenceBindingSchema).min(2).max(100),
    citationIds: z.array(StableIdSchema).min(1).max(500)
  })
  .strict()
  .superRefine((cluster, context) => {
    validateUniqueRepositoryBindings(cluster.repositories, context);
    addUniqueValueIssue(
      cluster.citationIds,
      context,
      ["citationIds"],
      "citationId values must be unique"
    );
  });

export const RecommendationActionSchema = z.enum([
  "keep-standalone",
  "combine-with-peer",
  "extract-shared-component",
  "adopt-capability-into-orchestrator",
  "archive-candidate",
  "defer-insufficient-evidence"
]);

export const RECOMMENDATION_CONFIDENCE_WEIGHTS = {
  coverage: 0.35,
  citations: 0.25,
  classifierAgreement: 0.2,
  ruleSupport: 0.2
} as const;

const ConfidenceFactorSchema = z.number().finite().min(0).max(1);

export const RecommendationConfidenceSchema = z
  .object({
    coverage: ConfidenceFactorSchema,
    citations: ConfidenceFactorSchema,
    classifierAgreement: ConfidenceFactorSchema,
    ruleSupport: ConfidenceFactorSchema,
    weightedConfidence: ConfidenceFactorSchema
  })
  .strict()
  .superRefine((confidence, context) => {
    const expected =
      confidence.coverage * RECOMMENDATION_CONFIDENCE_WEIGHTS.coverage +
      confidence.citations * RECOMMENDATION_CONFIDENCE_WEIGHTS.citations +
      confidence.classifierAgreement *
        RECOMMENDATION_CONFIDENCE_WEIGHTS.classifierAgreement +
      confidence.ruleSupport * RECOMMENDATION_CONFIDENCE_WEIGHTS.ruleSupport;
    if (Math.abs(confidence.weightedConfidence - expected) > 1e-9) {
      context.addIssue({
        code: "custom",
        message: "weightedConfidence must match the fixed confidence weights",
        path: ["weightedConfidence"]
      });
    }
  });

export const RecommendationLifecycleSchema = z.enum([
  "draft",
  "auto-finalized",
  "overridden",
  "deferred"
]);

export const PortfolioRecommendationSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    recommendationId: StableIdSchema,
    runId: StableIdSchema,
    clusterId: StableIdSchema.optional(),
    action: RecommendationActionSchema,
    lifecycle: RecommendationLifecycleSchema,
    createdAt: UtcTimestampSchema,
    evidenceObjectSha256: Sha256Schema,
    repositories: z.array(RepositoryEvidenceBindingSchema).min(1).max(100),
    citationIds: z.array(StableIdSchema).min(1).max(500),
    rationale: z.string().min(1).max(10_000),
    confidence: RecommendationConfidenceSchema
  })
  .strict()
  .superRefine((recommendation, context) => {
    validateUniqueRepositoryBindings(recommendation.repositories, context);
    addUniqueValueIssue(
      recommendation.citationIds,
      context,
      ["citationIds"],
      "citationId values must be unique"
    );
    if (
      recommendation.action === "combine-with-peer" &&
      recommendation.repositories.length < 2
    ) {
      context.addIssue({
        code: "custom",
        message: "combine-with-peer requires at least two repositories",
        path: ["repositories"]
      });
    }
    if (
      recommendation.lifecycle === "deferred" &&
      recommendation.action !== "defer-insufficient-evidence"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "the deferred lifecycle requires defer-insufficient-evidence",
        path: ["lifecycle"]
      });
    }
    if (
      recommendation.lifecycle === "auto-finalized" &&
      (recommendation.confidence.weightedConfidence < 0.9 ||
        recommendation.confidence.coverage !== 1 ||
        recommendation.confidence.citations !== 1 ||
        recommendation.confidence.classifierAgreement !== 1 ||
        recommendation.confidence.ruleSupport !== 1)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "auto-finalized recommendations require the exact confidence gate",
        path: ["confidence"]
      });
    }
  });

export const UserOverrideReasonCodeSchema = z.enum([
  "incorrect-evidence",
  "missing-context",
  "strategic-priority",
  "risk-tolerance",
  "other"
]);

export const UserOverrideReasonSchema = z
  .object({
    reasonCode: UserOverrideReasonCodeSchema,
    explanation: z.string().min(1).max(10_000),
    providedBy: StableIdSchema,
    providedAt: UtcTimestampSchema
  })
  .strict();

export const RecommendationDecisionActorSchema = z.enum(["system", "user"]);

export const RecommendationDecisionEventSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    eventId: StableIdSchema,
    recommendationId: StableIdSchema,
    runId: StableIdSchema,
    sequence: z.number().int().nonnegative(),
    actor: RecommendationDecisionActorSchema,
    previousLifecycle: RecommendationLifecycleSchema.optional(),
    previousAction: RecommendationActionSchema.optional(),
    lifecycle: RecommendationLifecycleSchema,
    action: RecommendationActionSchema,
    occurredAt: UtcTimestampSchema,
    recommendationObjectSha256: Sha256Schema,
    evidenceObjectSha256: Sha256Schema,
    receiptObjectSha256: Sha256Schema,
    repositories: z.array(RepositoryEvidenceBindingSchema).min(1).max(100),
    reason: z.string().min(1).max(10_000),
    override: UserOverrideReasonSchema.optional()
  })
  .strict()
  .superRefine((event, context) => {
    validateUniqueRepositoryBindings(event.repositories, context);
    if (
      (event.previousLifecycle === undefined) !==
      (event.previousAction === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "previous lifecycle and action must be recorded together",
        path: ["previousAction"]
      });
    }
    if (event.lifecycle === "overridden") {
      if (event.actor !== "user") {
        context.addIssue({
          code: "custom",
          message: "an overridden recommendation requires a user actor",
          path: ["actor"]
        });
      }
      if (event.override === undefined) {
        context.addIssue({
          code: "custom",
          message: "an overridden recommendation requires a user override reason",
          path: ["override"]
        });
      }
      if (
        event.previousLifecycle === undefined ||
        event.previousAction === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "an override must record the previous recommendation state",
          path: ["previousLifecycle"]
        });
      }
    } else if (event.override !== undefined) {
      context.addIssue({
        code: "custom",
        message: "override metadata is only valid for the overridden lifecycle",
        path: ["override"]
      });
    }
    if (
      event.lifecycle === "deferred" &&
      event.action !== "defer-insufficient-evidence"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "the deferred lifecycle requires defer-insufficient-evidence",
        path: ["lifecycle"]
      });
    }
  });

export type SourceType = z.infer<typeof SourceTypeSchema>;
export type SourceReference = z.infer<typeof SourceReferenceSchema>;
export type ConversationActor = z.infer<typeof ConversationActorSchema>;
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;
export type ConversationSnapshot = z.infer<typeof ConversationSnapshotSchema>;
export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;
export type ReconciliationStatus = z.infer<
  typeof ReconciliationStatusSchema
>;
export type ClaimType = z.infer<typeof ClaimTypeSchema>;
export type ClaimRecord = z.infer<typeof ClaimRecordSchema>;
export type ReceiptOutcome = z.infer<typeof ReceiptOutcomeSchema>;
export type EvidenceReceipt = z.infer<typeof EvidenceReceiptSchema>;
export type CapturedRevision = z.infer<typeof CapturedRevisionSchema>;
export type EvidenceFamily = z.infer<typeof EvidenceFamilySchema>;
export type RepositoryEvidenceBinding = z.infer<
  typeof RepositoryEvidenceBindingSchema
>;
export type RepositoryEvidenceRecord = z.infer<
  typeof RepositoryEvidenceRecordSchema
>;
export type RepositorySnapshot = z.infer<typeof RepositorySnapshotSchema>;
export type RepositoryProfile = z.infer<typeof RepositoryProfileSchema>;
export type RepositoryCitation = z.infer<typeof RepositoryCitationSchema>;
export type PortfolioRunStatus = z.infer<typeof PortfolioRunStatusSchema>;
export type PortfolioRun = z.infer<typeof PortfolioRunSchema>;
export type PortfolioRunError = z.infer<typeof PortfolioRunErrorSchema>;
export type PortfolioRunCheckpoint = z.infer<
  typeof PortfolioRunCheckpointSchema
>;
export type OverlapCluster = z.infer<typeof OverlapClusterSchema>;
export type RecommendationAction = z.infer<typeof RecommendationActionSchema>;
export type RecommendationConfidence = z.infer<
  typeof RecommendationConfidenceSchema
>;
export type RecommendationLifecycle = z.infer<
  typeof RecommendationLifecycleSchema
>;
export type PortfolioRecommendation = z.infer<
  typeof PortfolioRecommendationSchema
>;
export type UserOverrideReasonCode = z.infer<
  typeof UserOverrideReasonCodeSchema
>;
export type UserOverrideReason = z.infer<typeof UserOverrideReasonSchema>;
export type RecommendationDecisionActor = z.infer<
  typeof RecommendationDecisionActorSchema
>;
export type RecommendationDecisionEvent = z.infer<
  typeof RecommendationDecisionEventSchema
>;

export const PINNED_OLLAMA_MODEL = "qwen3:4b" as const;

export const RuntimeServiceNameSchema = z.enum(["ollama", "whiteshadow"]);

export const RuntimeServicePhaseSchema = z.enum([
  "offline",
  "starting",
  "ready",
  "degraded",
  "blocked"
]);

export const RuntimeServiceStateSchema = z
  .object({
    service: RuntimeServiceNameSchema,
    phase: RuntimeServicePhaseSchema,
    endpoint: z.string().url(),
    checkedAt: UtcTimestampSchema,
    detail: z.string().min(1),
    model: z.string().min(1).optional()
  })
  .strict();

export const RuntimeStatusSchema = z
  .object({
    model: z.literal(PINNED_OLLAMA_MODEL),
    ollama: RuntimeServiceStateSchema,
    whiteshadow: RuntimeServiceStateSchema
  })
  .strict()
  .superRefine((status, context) => {
    if (status.ollama.service !== "ollama") {
      context.addIssue({
        code: "custom",
        message: "ollama state must identify the ollama service",
        path: ["ollama", "service"]
      });
    }
    if (status.whiteshadow.service !== "whiteshadow") {
      context.addIssue({
        code: "custom",
        message: "whiteshadow state must identify the whiteshadow service",
        path: ["whiteshadow", "service"]
      });
    }
  });

export const DevelopmentBranchPatternSchema = z.enum([
  "dev",
  "dev-*",
  "feature/*",
  "codex/*",
  "codex_ys/*",
  "backup/*"
]);

export const WorkspaceIdentitySchema = z
  .object({
    repositoryRoot: z.string().min(1),
    origin: z.string().min(1),
    originSha256: Sha256Schema,
    branch: z.string().min(1),
    protectedBranch: z.boolean()
  })
  .strict();

export const TrustGrantSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    grantId: StableIdSchema,
    repositoryRoot: z.string().min(1),
    originSha256: Sha256Schema,
    branchPatterns: z.array(DevelopmentBranchPatternSchema).min(1),
    grantedAt: UtcTimestampSchema,
    permanent: z.literal(true)
  })
  .strict();

export const TrustStateSchema = z
  .object({
    trusted: z.boolean(),
    identity: WorkspaceIdentitySchema,
    grant: TrustGrantSchema.nullable(),
    reason: z.string().min(1)
  })
  .strict();

export const RepositoryToolNameSchema = z.enum([
  "repository.list_files",
  "repository.read_file",
  "repository.search",
  "repository.git_status",
  "repository.git_diff",
  "repository.write_file",
  "repository.replace_text",
  "repository.create_directory",
  "repository.run_npm_script",
  "portfolio.list_repositories",
  "portfolio.get_repository",
  "portfolio.list_clusters",
  "portfolio.explain_overlap",
  "portfolio.list_recommendations",
  "portfolio.resolve_citation"
]);

export const RequestedToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "tool name cannot contain control characters"
  });

export const MALFORMED_TOOL_CALL_NAME = "malformed.tool_call" as const;

export const RepositoryToolModeSchema = z.enum(["read", "write"]);

export const ToolDefinitionSchema = z
  .object({
    name: RepositoryToolNameSchema,
    description: z.string().min(1),
    mode: RepositoryToolModeSchema,
    inputSchema: z.record(z.string(), z.unknown())
  })
  .strict();

export const ToolCallSchema = z
  .object({
    callId: z.string().min(1).max(256),
    toolName: RequestedToolNameSchema,
    arguments: z.unknown()
  })
  .strict();

export const PolicyErrorCodeSchema = z.enum([
  "allowed",
  "workspace_untrusted",
  "repository_mismatch",
  "origin_mismatch",
  "protected_branch",
  "branch_not_allowed",
  "path_escape",
  "protected_path",
  "symlink_escape",
  "tool_not_allowed",
  "script_not_allowed",
  "invalid_input",
  "precondition_failed"
]);

export const PolicyDecisionSchema = z
  .object({
    allowed: z.boolean(),
    code: PolicyErrorCodeSchema,
    reason: z.string().min(1),
    checkedAt: UtcTimestampSchema
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.allowed !== (decision.code === "allowed")) {
      context.addIssue({
        code: "custom",
        message: "allowed must match the allowed decision code",
        path: ["allowed"]
      });
    }
  });

export const ToolResultSchema = z
  .object({
    callId: z.string().min(1).max(256),
    toolName: RequestedToolNameSchema,
    ok: z.boolean(),
    summary: z.string().min(1),
    data: z.unknown().optional(),
    contentSha256: Sha256Schema.optional(),
    truncated: z.boolean().default(false)
  })
  .strict();

export const AgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "stopped",
  "cancelled"
]);

export const AgentConversationMessageSchema = z
  .object({
    messageId: StableIdSchema,
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(100_000)
  })
  .strict();

export const AgentRunRequestSchema = z
  .object({
    runId: StableIdSchema.optional(),
    threadId: StableIdSchema.optional(),
    message: z.string().min(1).max(100_000).optional(),
    messages: z.array(AgentConversationMessageSchema).min(1).max(50).optional()
  })
  .strict()
  .superRefine((request, context) => {
    if ((request.message === undefined) === (request.messages === undefined)) {
      context.addIssue({
        code: "custom",
        message: "provide exactly one of message or messages",
        path: ["message"]
      });
    }
    if (
      request.messages !== undefined &&
      request.messages.at(-1)?.role !== "user"
    ) {
      context.addIssue({
        code: "custom",
        message: "the final conversation message must be from the user",
        path: ["messages"]
      });
    }
  });

export const AgentEventTypeSchema = z.enum([
  "run_started",
  "assistant_delta",
  "tool_started",
  "tool_completed",
  "run_completed",
  "run_failed",
  "run_stopped",
  "run_cancelled"
]);

export const AgentRunEventSchema = z
  .object({
    runId: StableIdSchema,
    sequence: z.number().int().nonnegative(),
    type: AgentEventTypeSchema,
    occurredAt: UtcTimestampSchema,
    message: z.string().min(1).optional(),
    toolCall: ToolCallSchema.optional(),
    toolResult: ToolResultSchema.optional()
  })
  .strict();

export const AgentToolReceiptSchema = z
  .object({
    callId: z.string().min(1).max(256),
    toolName: RequestedToolNameSchema,
    argumentsObjectSha256: Sha256Schema,
    policyCode: PolicyErrorCodeSchema,
    policyReason: z.string().min(1).max(2_000),
    policyCheckedAt: UtcTimestampSchema,
    outcome: z.enum(["succeeded", "failed", "blocked"]),
    resultObjectSha256: Sha256Schema.optional(),
    resultPayloadSha256: Sha256Schema.optional(),
    summary: z.string().min(1).max(2_000)
  })
  .strict();

export const AgentRuntimeConfigurationSchema = z
  .object({
    contextSize: z.literal(4096),
    temperature: z.literal(0.2),
    thinking: z.literal(false)
  })
  .strict();

export const AgentWorkspaceEvidenceSchema = z
  .object({
    repositoryRootSha256: Sha256Schema,
    originSha256: Sha256Schema,
    branch: z.string().min(1).max(500),
    trustGrantSha256: Sha256Schema.optional()
  })
  .strict();

export const AgentUsageSchema = z
  .object({
    available: z.boolean(),
    totalDuration: z.number().int().nonnegative().optional(),
    loadDuration: z.number().int().nonnegative().optional(),
    promptEvalCount: z.number().int().nonnegative().optional(),
    promptEvalDuration: z.number().int().nonnegative().optional(),
    evalCount: z.number().int().nonnegative().optional(),
    evalDuration: z.number().int().nonnegative().optional()
  })
  .strict()
  .superRefine((usage, context) => {
    const counterCount = Object.keys(usage).filter(
      (key) => key !== "available"
    ).length;
    if (usage.available !== (counterCount > 0)) {
      context.addIssue({
        code: "custom",
        message: "available must indicate whether Ollama usage counters were reported",
        path: ["available"]
      });
    }
  });

export const AgentRunReceiptSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    runId: StableIdSchema,
    threadId: StableIdSchema,
    messageIds: z.array(StableIdSchema).min(1).max(50),
    status: AgentRunStatusSchema.exclude(["queued", "running"]),
    model: z.literal(PINNED_OLLAMA_MODEL),
    runtime: AgentRuntimeConfigurationSchema,
    toolSchemaObjectSha256: Sha256Schema,
    workspace: AgentWorkspaceEvidenceSchema,
    startedAt: UtcTimestampSchema,
    completedAt: UtcTimestampSchema,
    iterations: z.number().int().nonnegative().max(8),
    toolCalls: z.array(AgentToolReceiptSchema).max(12),
    inputObjectSha256: Sha256Schema,
    outputObjectSha256: Sha256Schema.optional(),
    usage: AgentUsageSchema.default({ available: false }),
    warnings: z.array(z.string().min(1)).default([])
  })
  .strict()
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
      context.addIssue({
        code: "custom",
        message: "completedAt must not precede startedAt",
        path: ["completedAt"]
      });
    }
  });

export const OllamaRoleSchema = z.enum([
  "system",
  "user",
  "assistant",
  "tool"
]);

export const OllamaToolCallSchema = z
  .object({
    function: z
      .object({
        name: RequestedToolNameSchema,
        arguments: z.unknown().optional()
      })
      .strict()
  })
  .strict();

export const OllamaMessageSchema = z
  .object({
    role: OllamaRoleSchema,
    content: z.string(),
    thinking: z.string().optional(),
    tool_calls: z.array(OllamaToolCallSchema).optional(),
    tool_name: RequestedToolNameSchema.optional()
  })
  .strict();

export const OllamaChatChunkSchema = z
  .object({
    model: z.string().min(1),
    created_at: z.string().min(1),
    message: OllamaMessageSchema,
    done: z.boolean(),
    done_reason: z.string().optional(),
    total_duration: z.number().int().nonnegative().optional(),
    eval_count: z.number().int().nonnegative().optional()
  })
  .passthrough();

export const WhiteShadowCapabilitySchema = z
  .object({
    capabilityId: StableIdSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    risk: z.literal("safe"),
    modelUse: z.literal("none"),
    mode: z.literal("read")
  })
  .strict();

export const OrchestratorErrorCodeSchema = z.enum([
  "invalid_request",
  "runtime_offline",
  "runtime_start_failed",
  "model_missing",
  "model_mismatch",
  "workspace_untrusted",
  "policy_blocked",
  "tool_failed",
  "run_limit_reached",
  "run_cancelled",
  "evidence_failed",
  "upstream_error",
  "internal_error"
]);

export const ErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: OrchestratorErrorCodeSchema,
        message: z.string().min(1),
        retryable: z.boolean()
      })
      .strict()
  })
  .strict();

export type RuntimeServiceName = z.infer<typeof RuntimeServiceNameSchema>;
export type RuntimeServicePhase = z.infer<typeof RuntimeServicePhaseSchema>;
export type RuntimeServiceState = z.infer<typeof RuntimeServiceStateSchema>;
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;
export type DevelopmentBranchPattern = z.infer<
  typeof DevelopmentBranchPatternSchema
>;
export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>;
export type TrustGrant = z.infer<typeof TrustGrantSchema>;
export type TrustState = z.infer<typeof TrustStateSchema>;
export type RepositoryToolName = z.infer<typeof RepositoryToolNameSchema>;
export type RequestedToolName = z.infer<typeof RequestedToolNameSchema>;
export type RepositoryToolMode = z.infer<typeof RepositoryToolModeSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type PolicyErrorCode = z.infer<typeof PolicyErrorCodeSchema>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type AgentConversationMessage = z.infer<
  typeof AgentConversationMessageSchema
>;
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;
export type AgentRunEvent = z.infer<typeof AgentRunEventSchema>;
export type AgentToolReceipt = z.infer<typeof AgentToolReceiptSchema>;
export type AgentRuntimeConfiguration = z.infer<
  typeof AgentRuntimeConfigurationSchema
>;
export type AgentWorkspaceEvidence = z.infer<
  typeof AgentWorkspaceEvidenceSchema
>;
export type AgentUsage = z.infer<typeof AgentUsageSchema>;
export type AgentRunReceipt = z.infer<typeof AgentRunReceiptSchema>;
export type OllamaRole = z.infer<typeof OllamaRoleSchema>;
export type OllamaToolCall = z.infer<typeof OllamaToolCallSchema>;
export type OllamaMessage = z.infer<typeof OllamaMessageSchema>;
export type OllamaChatChunk = z.infer<typeof OllamaChatChunkSchema>;
export type WhiteShadowCapability = z.infer<
  typeof WhiteShadowCapabilitySchema
>;
export type OrchestratorErrorCode = z.infer<
  typeof OrchestratorErrorCodeSchema
>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
