import {
  DashboardBuildReceiptSchema,
  DashboardImportReceiptSchema,
  DashboardTemplateEventSchema,
  type DashboardBuildReceipt,
  type DashboardImportReceipt,
  type DashboardTemplateEvent
} from "@unified-ai/contracts/dashboard-builder";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "./canonical-json.js";
import { LocalEvidenceStore } from "./local-evidence-store.js";

const temporaryRoots: string[] = [];
const occurredAt = "2026-08-29T15:00:00.000Z";
const sha = "a".repeat(64);

async function makeStore(): Promise<{
  evidenceRoot: string;
  repositoryRoot: string;
  store: LocalEvidenceStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "uao-dashboard-evidence-test-"));
  temporaryRoots.push(root);
  const repositoryRoot = join(root, "repository");
  const evidenceRoot = join(repositoryRoot, ".local", "evidence");
  await mkdir(repositoryRoot, { recursive: true });
  const store = new LocalEvidenceStore({ root: evidenceRoot, repositoryRoot });
  await store.initialize();
  return { evidenceRoot, repositoryRoot, store };
}

function importReceipt(
  importId = "import-alpha",
  overrides: Partial<DashboardImportReceipt> = {}
): DashboardImportReceipt {
  return DashboardImportReceiptSchema.parse({
    schemaVersion: "dashboard-import-receipt/v1",
    importId,
    templateId: "template-alpha",
    actor: "local-operator",
    occurredAt,
    uploadBytes: 128,
    originalUploadSha256: sha,
    normalizedManifestSha256: sha,
    diagnosticCodes: [],
    ...overrides
  });
}

function buildReceipt(
  buildId = "build-alpha",
  overrides: Partial<DashboardBuildReceipt> = {}
): DashboardBuildReceipt {
  return DashboardBuildReceiptSchema.parse({
    schemaVersion: "dashboard-build-receipt/v1",
    buildId,
    templateId: "template-alpha",
    draftRevision: 1,
    adapterId: "fixture",
    status: "succeeded",
    startedAt: occurredAt,
    completedAt: occurredAt,
    manifestSha256: sha,
    validationObjectSha256: sha,
    componentCount: 6,
    rowCount: 8,
    diagnosticCodes: [],
    ...overrides
  });
}

function event(
  sequence: number,
  eventId = `event-${String(sequence)}`,
  overrides: Partial<DashboardTemplateEvent> = {}
): DashboardTemplateEvent {
  const base = {
    schemaVersion: "dashboard-template-event/v1" as const,
    eventId,
    templateId: "template-alpha",
    sequence,
    actor: "local-operator",
    occurredAt,
    previousEventSha256: sequence === 0 ? null : sha,
    manifestObjectSha256: sha,
    manifestSha256: sha,
    validationObjectSha256: sha
  };
  return DashboardTemplateEventSchema.parse(
    sequence === 0
      ? {
          ...base,
          eventType: "imported",
          originalUploadSha256: sha,
          importReceiptObjectSha256: sha,
          ...overrides
        }
      : { ...base, eventType: "draft-updated", ...overrides }
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { force: true, recursive: true })
    )
  );
});

describe("dashboard evidence records", () => {
  it("round-trips typed imports, builds, and a complete ordered event history", async () => {
    const { store } = await makeStore();
    const imported = importReceipt();
    const built = buildReceipt();
    const events = Array.from({ length: 101 }, (_, sequence) => event(sequence));

    await store.putDashboardImportReceipt(imported);
    await store.putDashboardBuildReceipt(built);
    await Promise.all(
      [...events].reverse().map((value) => store.putDashboardTemplateEvent(value))
    );

    await expect(store.readDashboardImportReceipt(imported.importId)).resolves.toEqual(
      imported
    );
    await expect(store.readDashboardBuildReceipt(built.buildId)).resolves.toEqual(built);
    const history = await store.listDashboardTemplateEvents("template-alpha");
    expect(history).toHaveLength(101);
    expect(history.map((value) => value.sequence)).toEqual(
      Array.from({ length: 101 }, (_, sequence) => sequence)
    );
    await expect(store.listDashboardImportReceipts("template-alpha")).resolves.toEqual([
      imported
    ]);
    await expect(store.listDashboardBuildReceipts("template-alpha")).resolves.toEqual([
      built
    ]);
  });

  it("keeps identical writes idempotent and rejects conflicting immutable IDs", async () => {
    const { store } = await makeStore();
    const same = importReceipt("import-idempotent");
    const identical = await Promise.all([
      store.putDashboardImportReceipt(same),
      store.putDashboardImportReceipt(same)
    ]);
    expect(identical[0]).toEqual(identical[1]);

    await store.putDashboardBuildReceipt(buildReceipt("build-conflict"));
    await expect(
      store.putDashboardBuildReceipt(
        buildReceipt("build-conflict", { templateId: "template-beta" })
      )
    ).rejects.toThrow(/different content/u);
  });

  it("allows only one winner for concurrent conflicting immutable writes", async () => {
    const { store } = await makeStore();
    const results = await Promise.allSettled([
      store.putDashboardBuildReceipt(buildReceipt("build-race")),
      store.putDashboardBuildReceipt(
        buildReceipt("build-race", { templateId: "template-beta" })
      )
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(store.readDashboardBuildReceipt("build-race")).resolves.toSatisfy(
      (receipt: DashboardBuildReceipt) =>
        ["template-alpha", "template-beta"].includes(receipt.templateId)
    );
  });

  it("fails closed on checksum, canonical JSON, and path identity tampering", async () => {
    const { evidenceRoot, store } = await makeStore();
    await store.putDashboardBuildReceipt(buildReceipt());
    const target = join(evidenceRoot, "dashboard-builds", "build-alpha.json");
    await writeFile(target, `${await readFile(target, "utf8")} `, "utf8");
    await expect(store.readDashboardBuildReceipt("build-alpha")).rejects.toThrow(
      /content-addressed integrity/u
    );

    const mismatched = buildReceipt("build-other");
    const canonical = canonicalJson(mismatched);
    await writeFile(target, canonical, "utf8");
    await writeFile(
      join(evidenceRoot, "dashboard-builds", "build-alpha.sha256"),
      sha256Hex(canonical),
      "utf8"
    );
    await expect(store.readDashboardBuildReceipt("build-alpha")).rejects.toThrow(
      /path identity integrity/u
    );
  });

  it("rejects traversal identifiers and malformed event-history filenames", async () => {
    const { evidenceRoot, store } = await makeStore();
    await expect(
      store.readDashboardTemplateEvent("../escape", "event-one")
    ).rejects.toThrow();
    const eventDirectory = join(
      evidenceRoot,
      "dashboard-templates",
      "template-alpha",
      "events"
    );
    await mkdir(eventDirectory, { recursive: true });
    await writeFile(join(eventDirectory, "Not-A-Stable-Id.json"), "{}", "utf8");
    await expect(store.listDashboardTemplateEvents("template-alpha")).rejects.toThrow(
      /invalid record identifier/u
    );
  });

  it("rejects symbolic-link records instead of following them", async (context) => {
    const { evidenceRoot, repositoryRoot, store } = await makeStore();
    const outside = join(repositoryRoot, "outside-event.json");
    const eventDirectory = join(
      evidenceRoot,
      "dashboard-templates",
      "template-alpha",
      "events"
    );
    await mkdir(eventDirectory, { recursive: true });
    await writeFile(outside, canonicalJson(event(0)), "utf8");
    try {
      await symlink(outside, join(eventDirectory, "event-zero.json"), "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(store.listDashboardTemplateEvents("template-alpha")).rejects.toThrow(
      /symbolic link|junction/u
    );
  });
});
