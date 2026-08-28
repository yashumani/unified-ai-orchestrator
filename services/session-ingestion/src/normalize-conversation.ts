import {
  ClaimRecordSchema,
  ConversationSnapshotSchema,
  EvidenceEnvelopeSchema,
  EvidenceReceiptSchema,
  SCHEMA_VERSION,
  SourceReferenceSchema,
  type ClaimRecord,
  type ConversationSnapshot,
  type EvidenceReceipt
} from "@unified-ai/contracts";
import {
  LocalEvidenceStore,
  canonicalJson,
  sha256Hex,
  type StoredObject
} from "@unified-ai/evidence-index";

export interface ConversationIngestionResult {
  sourceObject: StoredObject;
  claimObjects: StoredObject[];
  claims: ClaimRecord[];
  receiptObject: StoredObject;
  receipt: EvidenceReceipt;
}

function derivedId(prefix: string, value: unknown): string {
  return `${prefix}-${sha256Hex(canonicalJson(value)).slice(0, 24)}`;
}

export async function ingestConversationSnapshot(
  input: unknown,
  store: LocalEvidenceStore
): Promise<ConversationIngestionResult> {
  const snapshot = ConversationSnapshotSchema.parse(input);
  const snapshotSha256 = sha256Hex(canonicalJson(snapshot));

  const source = SourceReferenceSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    sourceId: snapshot.conversationId,
    sourceType: "chatgpt-conversation",
    capturedAt: snapshot.updatedAt,
    contentSha256: snapshotSha256,
    locator: {
      projectId: snapshot.projectId,
      conversationId: snapshot.conversationId
    }
  });

  const envelope = EvidenceEnvelopeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    evidenceId: derivedId("evidence", snapshot),
    capturedAt: snapshot.updatedAt,
    mediaType: "application/vnd.unified-ai.conversation+json",
    source,
    payload: snapshot
  });

  const sourceObject = await store.putObject(envelope);
  const claims: ClaimRecord[] = [];
  const claimObjects: StoredObject[] = [];

  for (const turn of snapshot.turns) {
    if (turn.actor !== "user" && turn.actor !== "assistant") {
      continue;
    }

    const claimSource = SourceReferenceSchema.parse({
      ...source,
      capturedAt: turn.occurredAt,
      contentSha256: sha256Hex(canonicalJson(turn)),
      locator: {
        ...source.locator,
        turnId: turn.turnId
      }
    });

    const claim = ClaimRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      claimId: derivedId("claim", {
        conversationId: snapshot.conversationId,
        turnId: turn.turnId,
        actor: turn.actor
      }),
      claimType: turn.actor === "user" ? "requirement" : "implementation",
      assertedBy: turn.actor,
      statement: turn.content,
      status: "unverified",
      source: claimSource,
      evidenceObjectSha256: sourceObject.sha256
    });

    claims.push(claim);
    claimObjects.push(await store.putObject(claim));
  }

  const receipt = EvidenceReceiptSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    receiptId: derivedId("receipt", {
      operation: "ingest-conversation",
      sourceObjectSha256: sourceObject.sha256
    }),
    operation: "ingest-conversation",
    startedAt: snapshot.updatedAt,
    completedAt: snapshot.updatedAt,
    inputObjectSha256: [sourceObject.sha256],
    claimIds: claims.map((claim) => claim.claimId),
    outcome: "succeeded",
    warnings: []
  });

  const receiptObject = await store.putReceipt(receipt);

  return {
    sourceObject,
    claimObjects,
    claims,
    receiptObject,
    receipt
  };
}
