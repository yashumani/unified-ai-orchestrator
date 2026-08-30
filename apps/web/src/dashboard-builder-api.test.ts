import {
  DASHBOARD_MAX_UPLOAD_BYTES,
  DashboardManifestSchema,
  type DashboardManifest
} from "@unified-ai/contracts/dashboard-builder";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DashboardBuilderApiError,
  downloadDashboardRevision,
  downloadDashboardSample,
  getDashboardTemplate,
  importDashboardManifest,
  updateDashboardDraft,
  validateDashboardDraft
} from "./dashboard-builder-api";

const sha = "a".repeat(64);
let manifest: DashboardManifest;
let rawManifest: string;
let fetchMock: ReturnType<typeof vi.fn>;
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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function templateResponse() {
  return {
    template: {
      templateId: manifest.template.templateId,
      name: manifest.template.name,
      currentRevision: 0,
      activeRevisionNumber: null,
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
  } as const;
}

beforeEach(async () => {
  rawManifest = await readFile(manifestPath, "utf8");
  manifest = DashboardManifestSchema.parse(JSON.parse(rawManifest) as unknown);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dashboard builder API client", () => {
  it("downloads and runtime-validates the tracked sample", async () => {
    fetchMock.mockResolvedValue(new Response(rawManifest, { status: 200 }));

    const download = await downloadDashboardSample();

    expect(download).toEqual({
      fileName: "sales-overview.dashboard.json",
      json: rawManifest,
      manifest
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard-builder/sample",
      expect.objectContaining({ method: "GET", credentials: "omit", cache: "no-store" })
    );
  });

  it("sends the original JSON upload bytes without wrapping them", async () => {
    const response = {
      template: templateResponse().template,
      receipt: {
        schemaVersion: "dashboard-import-receipt/v1",
        importId: "dashboard-import-alpha",
        templateId: "sales-overview",
        actor: "local-operator",
        occurredAt: "2026-08-29T16:00:00.000Z",
        uploadBytes: new TextEncoder().encode(rawManifest).byteLength,
        originalUploadSha256: sha,
        normalizedManifestSha256: sha,
        diagnosticCodes: []
      },
      diagnostics: []
    };
    fetchMock.mockResolvedValue(jsonResponse(response));

    await expect(importDashboardManifest(rawManifest)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard-builder/imports",
      expect.objectContaining({
        method: "POST",
        body: rawManifest,
        headers: expect.objectContaining({ "content-type": "application/json" })
      })
    );
  });

  it("rejects an oversized upload before reading the network", async () => {
    await expect(
      importDashboardManifest("x".repeat(DASHBOARD_MAX_UPLOAD_BYTES + 1))
    ).rejects.toMatchObject({ status: 413, code: "dashboard-upload-too-large" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("encodes template identifiers and validates PUT request and response bodies", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(templateResponse()));

    await getDashboardTemplate("sales overview/unsafe");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/dashboard-builder/templates/sales%20overview%2Funsafe",
      expect.any(Object)
    );

    await updateDashboardDraft("sales-overview", {
      expectedRevision: 0,
      actor: "local-operator",
      manifest
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/dashboard-builder/templates/sales-overview/draft",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: 0,
          actor: "local-operator",
          manifest
        })
      })
    );
  });

  it("returns bounded conflict metadata and never exposes a raw error body", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "revision-conflict",
            message: "The dashboard draft changed after it was loaded.",
            retryable: false,
            details: { templateId: "sales-overview", currentRevision: 4 },
            rawManifest: "must-not-escape"
          }
        },
        409
      )
    );

    const error = await getDashboardTemplate("sales-overview").catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(DashboardBuilderApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "revision-conflict",
      details: { templateId: "sales-overview", currentRevision: 4 }
    });
    expect(JSON.stringify(error)).not.toContain("must-not-escape");
  });

  it("fails closed when a successful response violates its runtime schema", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ template: { templateId: "broken" } }));

    await expect(getDashboardTemplate("broken")).rejects.toMatchObject({
      status: 502,
      code: "dashboard-response-invalid"
    });
  });

  it("parses governed validation diagnostics from an expected 422 response", async () => {
    const validation = {
      schemaVersion: "dashboard-validation/v1",
      valid: false,
      publishEligible: false,
      normalizedManifest: null,
      manifestSha256: null,
      diagnostics: [
        {
          severity: "error",
          code: "unknown-binding",
          path: "/calculations/0/expression",
          message: "The referenced binding does not exist."
        }
      ]
    };
    fetchMock.mockResolvedValue(jsonResponse(validation, 422));

    await expect(
      validateDashboardDraft("sales-overview", { manifest, mode: "draft" })
    ).resolves.toEqual(validation);
  });

  it("downloads a validated immutable revision with a stable filename", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        revision: {
          templateId: "sales-overview",
          revisionNumber: 2,
          eventId: "event-two",
          eventType: "published",
          sourceRevisionNumber: null,
          manifestSha256: sha,
          actor: "local-operator",
          occurredAt: "2026-08-29T16:00:00.000Z",
          buildId: "build-two"
        },
        manifest
      })
    );

    const download = await downloadDashboardRevision("sales-overview", 2);

    expect(download.fileName).toBe("sales-overview.revision-2.dashboard.json");
    expect(download.manifest).toEqual(manifest);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard-builder/templates/sales-overview/revisions/2",
      expect.any(Object)
    );
  });
});
