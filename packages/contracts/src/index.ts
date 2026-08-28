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
  "repository.run_npm_script"
]);

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
    toolName: RepositoryToolNameSchema,
    arguments: z.record(z.string(), z.unknown())
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
    toolName: RepositoryToolNameSchema,
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

export const AgentRunRequestSchema = z
  .object({
    runId: StableIdSchema.optional(),
    message: z.string().min(1).max(100_000)
  })
  .strict();

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
    toolName: RepositoryToolNameSchema,
    policyCode: PolicyErrorCodeSchema,
    outcome: z.enum(["succeeded", "failed", "blocked"]),
    resultObjectSha256: Sha256Schema.optional()
  })
  .strict();

export const AgentRunReceiptSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    runId: StableIdSchema,
    status: AgentRunStatusSchema.exclude(["queued", "running"]),
    model: z.literal(PINNED_OLLAMA_MODEL),
    startedAt: UtcTimestampSchema,
    completedAt: UtcTimestampSchema,
    iterations: z.number().int().nonnegative().max(8),
    toolCalls: z.array(AgentToolReceiptSchema).max(12),
    inputObjectSha256: Sha256Schema,
    outputObjectSha256: Sha256Schema.optional(),
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
        name: RepositoryToolNameSchema,
        arguments: z.record(z.string(), z.unknown())
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
    tool_name: RepositoryToolNameSchema.optional()
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
export type RepositoryToolMode = z.infer<typeof RepositoryToolModeSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type PolicyErrorCode = z.infer<typeof PolicyErrorCodeSchema>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;
export type AgentRunEvent = z.infer<typeof AgentRunEventSchema>;
export type AgentToolReceipt = z.infer<typeof AgentToolReceiptSchema>;
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
