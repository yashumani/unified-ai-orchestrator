import {
  DashboardManifestSchema,
  DashboardTemplateResponseSchema,
  type DashboardManifest
} from "@unified-ai/contracts/dashboard-builder";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  dashboardBuilderReducer,
  initialDashboardBuilderState
} from "./dashboardBuilderReducer";

const sha = "a".repeat(64);
let manifest: DashboardManifest;
const repositoryRoot = process.cwd().endsWith(`${sep}apps${sep}web`)
  ? resolve(process.cwd(), "..", "..")
  : process.cwd();
const manifestPath = resolve(
  repositoryRoot,
  "sources",
  "fixtures",
  "dashboard-builder",
  "sales-overview.manifest.json"
);

beforeAll(async () => {
  manifest = DashboardManifestSchema.parse(
    JSON.parse(
      await readFile(
        manifestPath,
        "utf8"
      )
    ) as unknown
  );
});

function response() {
  return DashboardTemplateResponseSchema.parse({
    template: {
      templateId: "sales-overview",
      name: "Sales overview",
      currentRevision: 2,
      activeRevisionNumber: 1,
      manifestSha256: sha,
      integrity: "verified"
    },
    manifest,
    validation: {
      schemaVersion: "dashboard-validation/v1",
      valid: true,
      publishEligible: true,
      normalizedManifest: manifest,
      manifestSha256: sha,
      diagnostics: []
    }
  });
}

describe("dashboard builder reducer", () => {
  it("loads one synchronized form and JSON draft", () => {
    const state = dashboardBuilderReducer(initialDashboardBuilderState, {
      type: "template-loaded",
      response: response(),
      revisions: []
    });

    expect(state.draft).toEqual(manifest);
    expect(JSON.parse(state.jsonText)).toEqual(manifest);
    expect(state.dirty).toBe(false);
    expect(state.validation?.publishEligible).toBe(true);
  });

  it("marks form edits dirty and clears stale preview state", () => {
    const loaded = dashboardBuilderReducer(initialDashboardBuilderState, {
      type: "template-loaded",
      response: response(),
      revisions: []
    });
    const edited = structuredClone(manifest);
    edited.template.name = "Edited dashboard";
    const state = dashboardBuilderReducer(
      { ...loaded, preview: { buildId: "stale" } as never },
      { type: "manifest-edited", manifest: edited }
    );

    expect(state.dirty).toBe(true);
    expect(state.preview).toBeNull();
    expect(state.validation).toBeNull();
    expect(state.jsonText).toContain("Edited dashboard");
  });

  it("preserves invalid JSON text and the last valid structured draft", () => {
    const loaded = dashboardBuilderReducer(initialDashboardBuilderState, {
      type: "template-loaded",
      response: response(),
      revisions: []
    });
    const state = dashboardBuilderReducer(loaded, {
      type: "json-edited",
      text: '{"schemaVersion":',
      error: "Incomplete JSON"
    });

    expect(state.jsonText).toBe('{"schemaVersion":');
    expect(state.jsonError).toBe("Incomplete JSON");
    expect(state.draft).toEqual(manifest);
    expect(state.validation).toBeNull();
    expect(state.dirty).toBe(true);
  });

  it("keeps the local draft and records server conflict metadata", () => {
    const loaded = dashboardBuilderReducer(initialDashboardBuilderState, {
      type: "template-loaded",
      response: response(),
      revisions: []
    });
    const state = dashboardBuilderReducer(
      { ...loaded, dirty: true },
      {
        type: "action-failed",
        message: "The dashboard draft changed.",
        conflictRevision: 7
      }
    );

    expect(state.draft).toEqual(manifest);
    expect(state.dirty).toBe(true);
    expect(state.conflictRevision).toBe(7);
  });

  it("cancels preview state when a buffered expression edit starts", () => {
    const loaded = dashboardBuilderReducer(initialDashboardBuilderState, {
      type: "template-loaded",
      response: response(),
      revisions: []
    });
    const previewing = dashboardBuilderReducer(loaded, {
      type: "preview-loading"
    });
    const state = dashboardBuilderReducer(previewing, {
      type: "buffer-edited"
    });

    expect(state.previewLoading).toBe(false);
    expect(state.dirty).toBe(true);
    expect(state.validation).toBeNull();
  });
});
