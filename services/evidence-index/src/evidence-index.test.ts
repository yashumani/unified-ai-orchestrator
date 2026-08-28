import {
  EvidenceReceiptSchema,
  SCHEMA_VERSION,
  type EvidenceReceipt
} from "@unified-ai/contracts";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "./canonical-json.js";
import {
  LocalEvidenceStore,
  resolveWithinRoot
} from "./local-evidence-store.js";

const temporaryRoots: string[] = [];

async function makeStore(): Promise<{
  root: string;
  repositoryRoot: string;
  store: LocalEvidenceStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "uao-evidence-test-"));
  temporaryRoots.push(root);

  const repositoryRoot = join(root, "repository");
  const evidenceRoot = join(repositoryRoot, ".local", "evidence");
  await mkdir(repositoryRoot, { recursive: true });

  return {
    root,
    repositoryRoot,
    store: new LocalEvidenceStore({
      root: evidenceRoot,
      repositoryRoot
    })
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("canonical JSON", () => {
  it("sorts object keys and produces deterministic hashes", () => {
    const first = canonicalJson({ z: 1, a: { y: true, b: "value" } });
    const second = canonicalJson({ a: { b: "value", y: true }, z: 1 });

    expect(first).toBe('{"a":{"b":"value","y":true},"z":1}');
    expect(second).toBe(first);
    expect(sha256Hex(first)).toBe(sha256Hex(second));
  });

  it("rejects cycles and unsupported values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/u);
    expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/u);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/u);
  });
});

describe("local evidence store", () => {
  it("rejects traversal outside its root", () => {
    expect(() => resolveWithinRoot("C:\\safe-root", "..", "escape.json")).toThrow(
      /escapes/u
    );
  });

  it("rejects the repository root and its parent as evidence roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "uao-root-test-"));
    temporaryRoots.push(root);
    const repositoryRoot = join(root, "repository");
    await mkdir(repositoryRoot);

    expect(
      () =>
        new LocalEvidenceStore({
          root: repositoryRoot,
          repositoryRoot
        })
    ).toThrow(/repository root/u);

    expect(
      () =>
        new LocalEvidenceStore({
          root,
          repositoryRoot
        })
    ).toThrow(/cannot contain/u);
  });

  it("writes identical objects idempotently and verifies integrity", async () => {
    const { repositoryRoot, store } = await makeStore();
    const value = { schemaVersion: SCHEMA_VERSION, message: "synthetic" };

    const first = await store.putObject(value);
    const second = await store.putObject({ message: "synthetic", schemaVersion: SCHEMA_VERSION });

    expect(second).toEqual(first);
    expect(await store.readObject(first.sha256)).toEqual(value);
    expect(resolve(repositoryRoot, first.relativePath)).not.toBe(repositoryRoot);
  });

  it("detects tampered evidence", async () => {
    const { repositoryRoot, store } = await makeStore();
    const stored = await store.putObject({ value: "original" });
    const evidenceRoot = join(repositoryRoot, ".local", "evidence");
    const target = join(evidenceRoot, stored.relativePath);

    await writeFile(target, '{"value":"tampered"}', "utf8");

    await expect(store.readObject(stored.sha256)).rejects.toThrow(/integrity/u);
  });

  it("stores receipts immutably", async () => {
    const { repositoryRoot, store } = await makeStore();
    const receipt: EvidenceReceipt = EvidenceReceiptSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      receiptId: "receipt-001",
      operation: "ingest-conversation",
      startedAt: "2026-08-27T20:00:00.000Z",
      completedAt: "2026-08-27T20:00:00.000Z",
      inputObjectSha256: ["a".repeat(64)],
      claimIds: ["claim-001"],
      outcome: "succeeded",
      warnings: []
    });

    const first = await store.putReceipt(receipt);
    const second = await store.putReceipt(receipt);
    expect(second).toEqual(first);

    const target = join(repositoryRoot, ".local", "evidence", first.relativePath);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(receipt);

    await expect(
      store.putReceipt({
        ...receipt,
        warnings: ["different"]
      })
    ).rejects.toThrow(/immutable/u);
  });
});
