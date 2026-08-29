import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadDashboardSample } from "./sample-loader.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("tracked dashboard sample loader", () => {
  it("loads the owned native manifest and matching synthetic rows", async () => {
    const repositoryRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      ".."
    );
    const sample = await loadDashboardSample(repositoryRoot);

    expect(sample.manifest.template.templateId).toBe("sales-overview");
    expect(sample.fixture.fixtureId).toBe(sample.manifest.runtime.fixtureId);
    expect(sample.fixture.synthetic).toBe(true);
    expect(sample.manifestBytes.byteLength).toBeGreaterThan(0);
  });

  it("rejects a fixture path that traverses a directory link", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "uao-dashboard-sample-"));
    temporaryRoots.push(root);
    const repositoryRoot = join(root, "repository");
    const outside = join(root, "outside");
    await mkdir(repositoryRoot);
    await mkdir(outside);
    try {
      await symlink(
        outside,
        join(repositoryRoot, "sources"),
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }

    await expect(loadDashboardSample(repositoryRoot)).rejects.toThrow(
      /symbolic link|junction/u
    );
  });
});
