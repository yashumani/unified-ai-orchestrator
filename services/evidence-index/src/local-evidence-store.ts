import {
  AgentRunReceiptSchema,
  EvidenceReceiptSchema,
  Sha256Schema,
  StableIdSchema,
  type AgentRunReceipt,
  type EvidenceReceipt
} from "@unified-ai/contracts";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
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

const DEFAULT_AGENT_RUN_RECEIPT_LIMIT = 20;
const MAX_AGENT_RUN_RECEIPT_LIMIT = 100;

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

  async putAgentRunReceipt(receipt: AgentRunReceipt): Promise<StoredObject> {
    const parsed = AgentRunReceiptSchema.parse(receipt);
    const runId = StableIdSchema.parse(parsed.runId);
    const canonical = canonicalJson(parsed);
    const sha256 = sha256Hex(canonical);
    const root = await this.#rootPath();
    const target = resolveWithinRoot(root, "agent-runs", `${runId}.json`);
    const checksumTarget = resolveWithinRoot(
      root,
      "agent-runs",
      `${runId}.sha256`
    );

    await this.#writeImmutable(target, canonical);
    await this.#writeImmutable(checksumTarget, sha256);

    return {
      sha256,
      relativePath: relative(root, target).replaceAll("\\", "/")
    };
  }

  async readAgentRunReceipt(runId: string): Promise<AgentRunReceipt> {
    const parsedRunId = StableIdSchema.parse(runId);
    const root = await this.#rootPath();
    const target = resolveWithinRoot(root, "agent-runs", `${parsedRunId}.json`);
    const checksumTarget = resolveWithinRoot(
      root,
      "agent-runs",
      `${parsedRunId}.sha256`
    );
    const realTarget = await realpath(target);
    const realChecksumTarget = await realpath(checksumTarget);
    this.#assertContained(realTarget);
    this.#assertContained(realChecksumTarget);

    const content = await readFile(realTarget, "utf8");
    const expectedSha256 = Sha256Schema.parse(
      await readFile(realChecksumTarget, "utf8")
    );
    if (sha256Hex(content) !== expectedSha256) {
      throw new Error(
        "agent run receipt failed its content-addressed integrity check"
      );
    }

    const receipt = AgentRunReceiptSchema.parse(JSON.parse(content) as unknown);
    if (receipt.runId !== parsedRunId) {
      throw new Error("agent run receipt failed its path identity integrity check");
    }

    const canonical = canonicalJson(receipt);
    if (sha256Hex(content) !== sha256Hex(canonical)) {
      throw new Error("agent run receipt failed its canonical integrity check");
    }

    return receipt;
  }

  async listAgentRunReceipts(
    limit = DEFAULT_AGENT_RUN_RECEIPT_LIMIT
  ): Promise<AgentRunReceipt[]> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_AGENT_RUN_RECEIPT_LIMIT
    ) {
      throw new Error(
        `agent run receipt limit must be an integer from 1 to ${MAX_AGENT_RUN_RECEIPT_LIMIT}`
      );
    }

    const root = await this.#rootPath();
    const directory = resolveWithinRoot(root, "agent-runs");
    let entries;
    try {
      const realDirectory = await realpath(directory);
      this.#assertContained(realDirectory);
      entries = await readdir(realDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const receipts: AgentRunReceipt[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const runId = entry.name.slice(0, -".json".length);
      if (!StableIdSchema.safeParse(runId).success) {
        continue;
      }

      try {
        receipts.push(await this.readAgentRunReceipt(runId));
      } catch {
        // Listing is a safe summary surface: malformed or tampered entries are omitted.
      }
    }

    return receipts
      .sort((first, second) => {
        const completionOrder =
          Date.parse(second.completedAt) - Date.parse(first.completedAt);
        if (completionOrder !== 0) {
          return completionOrder;
        }
        return second.runId.localeCompare(first.runId);
      })
      .slice(0, limit);
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
