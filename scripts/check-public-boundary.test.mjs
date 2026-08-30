import { describe, expect, it } from "vitest";
import {
  findForbiddenDashboardFixtureContent,
  findForbiddenPaths
} from "./check-public-boundary.mjs";

describe("public repository boundary", () => {
  it("accepts public source and the environment example", () => {
    expect(
      findForbiddenPaths([
        "packages/contracts/src/index.ts",
        "sources/fixtures/conversation.synthetic.json",
        ".env.example"
      ])
    ).toEqual([]);
  });

  it("accepts a native fixture-backed synthetic dashboard sample", () => {
    const entries = [
      {
        path: "sources/fixtures/dashboard-builder/sample.manifest.json",
        content: JSON.stringify({
          schemaVersion: "dashboard-template/v1",
          provenance: { source: "native", sourceReference: null },
          runtime: { preferredAdapter: "fixture", fixtureId: "sample-v1" },
          components: [{ type: "text", text: "Synthetic sample." }]
        })
      },
      {
        path: "sources/fixtures/dashboard-builder/sample.rows.synthetic.json",
        content: JSON.stringify({
          schemaVersion: "dashboard-fixture/v1",
          fixtureId: "sample-v1",
          synthetic: true,
          fields: [{ fieldId: "region", valueType: "string" }],
          rows: [{ region: "North" }]
        })
      }
    ];

    expect(findForbiddenDashboardFixtureContent(entries)).toEqual([]);
  });

  it.each([
    [
      "non-native-source",
      {
        schemaVersion: "dashboard-template/v1",
        provenance: { source: "qlik-object-metadata", sourceReference: { tenantId: "real" } },
        runtime: { preferredAdapter: "qlik", fixtureId: null }
      }
    ],
    [
      "not-synthetic",
      {
        schemaVersion: "dashboard-fixture/v1",
        fixtureId: "sample-v1",
        synthetic: false,
        fields: [],
        rows: []
      }
    ],
    [
      "non-fixture-runtime",
      {
        schemaVersion: "dashboard-template/v1",
        provenance: { source: "native", sourceReference: null },
        runtime: { preferredAdapter: "qlik", fixtureId: null }
      }
    ],
    [
      "credential-content",
      {
        schemaVersion: "dashboard-fixture/v1",
        fixtureId: "sample-v1",
        synthetic: true,
        fields: [],
        rows: [{ accessToken: "secret-value" }]
      }
    ],
    [
      "vendor-asset",
      {
        schemaVersion: "dashboard-template/v1",
        provenance: { source: "native", sourceReference: null },
        runtime: { preferredAdapter: "fixture", fixtureId: "sample-v1" },
        vizlibTemplate: "extension.zip"
      }
    ],
    [
      "executable-field",
      {
        schemaVersion: "dashboard-template/v1",
        provenance: { source: "native", sourceReference: null },
        runtime: { preferredAdapter: "fixture", fixtureId: "sample-v1" },
        components: [{ type: "text", javascript: "alert(1)" }]
      }
    ]
  ])("rejects dashboard fixture rule %s", (rule, value) => {
    expect(
      findForbiddenDashboardFixtureContent([
        {
          path: "sources/fixtures/dashboard-builder/unsafe.manifest.json",
          content: JSON.stringify(value)
        }
      ])
    ).toEqual([
      {
        path: "sources/fixtures/dashboard-builder/unsafe.manifest.json",
        rule
      }
    ]);
  });

  it.each([
    [".local/evidence/object.json", "local-runtime"],
    [".env", "environment-file"],
    [".env.production", "environment-file"],
    [".playwright-cli/profile/state.json", "playwright-profile"],
    ["sources/private/source.json", "private-source"],
    ["sources/chatgpt/conversation.json", "chatgpt-source"],
    ["data/raw/export.json", "raw-data"],
    ["capture.transcript.jsonl", "session-transcript"],
    ["project.session.jsonl", "session-transcript"],
    ["evidence.sqlite3", "database"],
    ["model-cache/blob.bin", "local-cache"]
  ])("rejects %s", (path, rule) => {
    expect(findForbiddenPaths([path])).toEqual([{ path, rule }]);
  });
});
