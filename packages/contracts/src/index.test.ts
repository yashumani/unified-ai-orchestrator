import { describe, expect, it } from "vitest";
import {
  ClaimRecordSchema,
  ConversationSnapshotSchema,
  EvidenceEnvelopeSchema,
  SCHEMA_VERSION,
  SourceReferenceSchema
} from "./index.js";

const sha = "a".repeat(64);
const source = {
  schemaVersion: SCHEMA_VERSION,
  sourceId: "conversation-001",
  sourceType: "chatgpt-conversation",
  capturedAt: "2026-08-27T20:00:00.000Z",
  contentSha256: sha,
  locator: {
    conversationId: "conversation-001",
    turnId: "turn-001"
  }
} as const;

describe("provenance contracts", () => {
  it("accepts a valid source reference", () => {
    expect(SourceReferenceSchema.parse(source)).toEqual(source);
  });

  it("rejects non-lowercase or incomplete hashes", () => {
    expect(() =>
      SourceReferenceSchema.parse({
        ...source,
        contentSha256: "A".repeat(64)
      })
    ).toThrow();

    expect(() =>
      SourceReferenceSchema.parse({
        ...source,
        contentSha256: "a".repeat(63)
      })
    ).toThrow();
  });

  it("requires UTC timestamps", () => {
    expect(() =>
      SourceReferenceSchema.parse({
        ...source,
        capturedAt: "2026-08-27T16:00:00.000-04:00"
      })
    ).toThrow();
  });

  it("defaults conversation-derived claims to unverified", () => {
    const claim = ClaimRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      claimId: "claim-001",
      claimType: "implementation",
      assertedBy: "assistant",
      statement: "The feature is deployed.",
      source,
      evidenceObjectSha256: sha
    });

    expect(claim.status).toBe("unverified");
  });

  it("rejects duplicate conversation turn identifiers", () => {
    const turn = {
      schemaVersion: SCHEMA_VERSION,
      turnId: "turn-001",
      actor: "user",
      occurredAt: "2026-08-27T20:00:00.000Z",
      content: "Build one orchestrator."
    } as const;

    expect(() =>
      ConversationSnapshotSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        sourceSystem: "chatgpt",
        projectId: "app-development",
        conversationId: "conversation-001",
        title: "Synthetic Unified Pilot",
        createdAt: "2026-08-27T20:00:00.000Z",
        updatedAt: "2026-08-27T20:01:00.000Z",
        turns: [turn, turn]
      })
    ).toThrow();
  });

  it("rejects unknown evidence-envelope fields", () => {
    expect(() =>
      EvidenceEnvelopeSchema.parse({
        schemaVersion: SCHEMA_VERSION,
        evidenceId: "evidence-001",
        capturedAt: "2026-08-27T20:00:00.000Z",
        mediaType: "application/json",
        source,
        payload: {},
        secret: "must-not-pass"
      })
    ).toThrow();
  });
});
