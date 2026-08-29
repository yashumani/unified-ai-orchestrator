import {
  DashboardFixtureDatasetSchema,
  DashboardManifestSchema,
  type DashboardFixtureDataset,
  type DashboardManifest
} from "@unified-ai/contracts/dashboard-builder";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DashboardBuilderError } from "./errors.js";

const MANIFEST_SEGMENTS = [
  "sources",
  "fixtures",
  "dashboard-builder",
  "sales-overview.manifest.json"
] as const;
const ROWS_SEGMENTS = [
  "sources",
  "fixtures",
  "dashboard-builder",
  "sales-overview.rows.synthetic.json"
] as const;

export interface LoadedDashboardSample {
  manifest: DashboardManifest;
  fixture: DashboardFixtureDataset;
  manifestBytes: Uint8Array;
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
}

async function readFixedFile(
  repositoryRoot: string,
  segments: readonly string[]
): Promise<Buffer> {
  if (!isAbsolute(repositoryRoot)) {
    throw new DashboardBuilderError(
      "evidence-integrity-failed",
      "The dashboard fixture repository root must be absolute."
    );
  }
  const lexicalRoot = resolve(repositoryRoot);
  const rootStats = await lstat(lexicalRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new DashboardBuilderError(
      "evidence-integrity-failed",
      "The dashboard fixture repository root is not a trusted directory."
    );
  }
  const trustedRoot = await realpath(lexicalRoot);
  let current = trustedRoot;
  for (const [index, segment] of segments.entries()) {
    const candidate = resolve(current, segment);
    if (!isContained(trustedRoot, candidate)) {
      throw new DashboardBuilderError(
        "evidence-integrity-failed",
        "The dashboard fixture path escapes the repository root."
      );
    }
    const stats = await lstat(candidate);
    if (stats.isSymbolicLink()) {
      throw new DashboardBuilderError(
        "evidence-integrity-failed",
        "The dashboard fixture path cannot traverse a symbolic link or junction."
      );
    }
    const final = index === segments.length - 1;
    if ((final && !stats.isFile()) || (!final && !stats.isDirectory())) {
      throw new DashboardBuilderError(
        "evidence-integrity-failed",
        "The dashboard fixture path has an unexpected file type."
      );
    }
    current = await realpath(candidate);
    if (!isContained(trustedRoot, current)) {
      throw new DashboardBuilderError(
        "evidence-integrity-failed",
        "The resolved dashboard fixture path escapes the repository root."
      );
    }
  }
  return readFile(current);
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch (error) {
    throw new DashboardBuilderError(
      "evidence-integrity-failed",
      `The tracked dashboard ${label} is not valid JSON.`,
      { cause: error }
    );
  }
}

export async function loadDashboardSample(
  repositoryRoot: string
): Promise<LoadedDashboardSample> {
  let manifestBytes: Buffer;
  let fixtureBytes: Buffer;
  try {
    [manifestBytes, fixtureBytes] = await Promise.all([
      readFixedFile(repositoryRoot, MANIFEST_SEGMENTS),
      readFixedFile(repositoryRoot, ROWS_SEGMENTS)
    ]);
  } catch (error) {
    if (error instanceof DashboardBuilderError) {
      throw error;
    }
    throw new DashboardBuilderError(
      "evidence-integrity-failed",
      "The tracked dashboard sample could not be read safely.",
      { cause: error }
    );
  }

  let manifest: DashboardManifest;
  let fixture: DashboardFixtureDataset;
  try {
    manifest = DashboardManifestSchema.parse(parseJson(manifestBytes, "manifest"));
    fixture = DashboardFixtureDatasetSchema.parse(parseJson(fixtureBytes, "fixture"));
  } catch (error) {
    if (error instanceof DashboardBuilderError) {
      throw error;
    }
    throw new DashboardBuilderError(
      "evidence-integrity-failed",
      "The tracked dashboard sample failed contract validation.",
      { cause: error }
    );
  }

  if (
    manifest.provenance.source !== "native" ||
    manifest.provenance.sourceReference !== null ||
    manifest.runtime.preferredAdapter !== "fixture" ||
    manifest.runtime.fixtureId !== fixture.fixtureId ||
    !fixture.synthetic
  ) {
    throw new DashboardBuilderError(
      "evidence-integrity-failed",
      "The tracked dashboard sample failed its native synthetic identity check."
    );
  }

  return { manifest, fixture, manifestBytes };
}
