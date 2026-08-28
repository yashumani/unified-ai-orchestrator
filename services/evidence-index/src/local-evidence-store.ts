import {
  EvidenceReceiptSchema,
  Sha256Schema,
  type EvidenceReceipt
} from "@unified-ai/contracts";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256Hex } from "./canonical-json.js";

export interface LocalEvidenceStoreOptions {
  root: string;
  repositoryRoot: string;
}

export interface StoredObject {
  sha256: string;
  relativePath: string;
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

export function resolveWithinRoot(root: string, ...segments: string[]): string {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, ...segments);

  if (!isContained(resolvedRoot, candidate)) {
    throw new Error("evidence path escapes the configured local root");
  }

  return candidate;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class LocalEvidenceStore {
  readonly root: string;
  readonly repositoryRoot: string;
  #realRoot: string | undefined;

  constructor(options: LocalEvidenceStoreOptions) {
    if (!isAbsolute(options.root) || !isAbsolute(options.repositoryRoot)) {
      throw new Error("evidence and repository roots must be absolute paths");
    }

    this.root = resolve(options.root);
    this.repositoryRoot = resolve(options.repositoryRoot);

    if (this.root === this.repositoryRoot) {
      throw new Error("the repository root cannot be used as the evidence root");
    }

    if (isContained(this.root, this.repositoryRoot)) {
      throw new Error("the evidence root cannot contain the repository");
    }
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const resolvedRoot = await realpath(this.root);
    const resolvedRepositoryRoot = await realpath(this.repositoryRoot);

    if (
      resolvedRoot === resolvedRepositoryRoot ||
      isContained(resolvedRoot, resolvedRepositoryRoot)
    ) {
      throw new Error("the resolved evidence root cannot contain the repository");
    }

    this.#realRoot = resolvedRoot;
  }

  async putObject(value: unknown): Promise<StoredObject> {
    const canonical = canonicalJson(value);
    const sha256 = sha256Hex(canonical);
    const target = await this.#objectPath(sha256);

    await this.#writeImmutable(target, canonical);

    return {
      sha256,
      relativePath: relative(await this.#rootPath(), target).replaceAll("\\", "/")
    };
  }

  async readObject(sha256: string): Promise<unknown> {
    const parsedHash = Sha256Schema.parse(sha256);
    const target = await this.#objectPath(parsedHash);
    const realTarget = await realpath(target);
    this.#assertContained(realTarget);

    const content = await readFile(realTarget, "utf8");
    if (sha256Hex(content) !== parsedHash) {
      throw new Error("stored evidence failed its SHA-256 integrity check");
    }

    return JSON.parse(content) as unknown;
  }

  async putReceipt(receipt: EvidenceReceipt): Promise<StoredObject> {
    const parsed = EvidenceReceiptSchema.parse(receipt);
    const canonical = canonicalJson(parsed);
    const root = await this.#rootPath();
    const target = resolveWithinRoot(root, "receipts", `${parsed.receiptId}.json`);

    await this.#writeImmutable(target, canonical);

    return {
      sha256: sha256Hex(canonical),
      relativePath: relative(root, target).replaceAll("\\", "/")
    };
  }

  async #rootPath(): Promise<string> {
    if (this.#realRoot === undefined) {
      await this.initialize();
    }
    return this.#realRoot as string;
  }

  async #objectPath(sha256: string): Promise<string> {
    const root = await this.#rootPath();
    return resolveWithinRoot(root, "objects", sha256.slice(0, 2), `${sha256}.json`);
  }

  #assertContained(candidate: string): void {
    if (this.#realRoot === undefined || !isContained(this.#realRoot, candidate)) {
      throw new Error("resolved evidence path escapes the configured local root");
    }
  }

  async #writeImmutable(target: string, content: string): Promise<void> {
    const parent = dirname(target);
    const realParent = await this.#ensureContainedDirectory(parent);
    const safeTarget = resolveWithinRoot(realParent, basename(target));

    if (await exists(safeTarget)) {
      const existing = await readFile(safeTarget, "utf8");
      if (existing !== content) {
        throw new Error("immutable evidence path already contains different content");
      }
      return;
    }

    const temporary = resolveWithinRoot(
      realParent,
      `.${randomUUID()}.temporary-evidence`
    );

    await writeFile(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });

    try {
      await rename(temporary, safeTarget);
    } catch (error) {
      if (await exists(safeTarget)) {
        const existing = await readFile(safeTarget, "utf8");
        if (existing === content) {
          return;
        }
      }
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #ensureContainedDirectory(target: string): Promise<string> {
    const root = await this.#rootPath();
    const pathFromRoot = relative(root, target);

    if (
      pathFromRoot.startsWith(`..${sep}`) ||
      pathFromRoot === ".." ||
      isAbsolute(pathFromRoot)
    ) {
      throw new Error("evidence directory escapes the configured local root");
    }

    let current = root;
    for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
      const candidate = resolveWithinRoot(current, segment);
      try {
        await mkdir(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }

      current = await realpath(candidate);
      this.#assertContained(current);
    }

    return current;
  }
}
