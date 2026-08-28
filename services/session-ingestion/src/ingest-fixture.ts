import { LocalEvidenceStore } from "@unified-ai/evidence-index";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestConversationSnapshot } from "./normalize-conversation.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(sourceDirectory, "../../..");
const fixturePath = resolve(
  repositoryRoot,
  process.argv[2] ?? "sources/fixtures/chatgpt/unified.synthetic.json"
);
const configuredEvidenceRoot =
  process.env.UAO_LOCAL_EVIDENCE_ROOT ?? ".local/evidence";
const evidenceRoot = resolve(repositoryRoot, configuredEvidenceRoot);

const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
const store = new LocalEvidenceStore({
  root: evidenceRoot,
  repositoryRoot
});
const result = await ingestConversationSnapshot(fixture, store);

console.log(
  JSON.stringify(
    {
      claimCount: result.claims.length,
      receiptId: result.receipt.receiptId,
      receiptSha256: result.receiptObject.sha256,
      sourceObjectSha256: result.sourceObject.sha256
    },
    null,
    2
  )
);
