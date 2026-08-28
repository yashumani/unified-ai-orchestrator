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
