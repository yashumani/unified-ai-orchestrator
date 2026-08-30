import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { build, version as esbuildVersion } from "esbuild";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const cliArguments = process.argv.slice(2);
if (
  cliArguments.length !== 0 &&
  (cliArguments.length !== 2 || cliArguments[0] !== "--output-root")
) {
  throw new Error("Usage: build-production-server-bundle.mjs [--output-root <directory>]");
}
const outputRoot = cliArguments.length === 0 ? repositoryRoot : resolve(cliArguments[1]);
const entrypoint = "apps/api/dist/server.js";
const output = "apps/api/dist/server.bundle.mjs";
const receiptOutput = "apps/api/dist/server.bundle.json";
const copilotRuntimeOutput = "apps/api/dist/copilot/runtime.js";
const absoluteOutput = resolve(outputRoot, output);
const absoluteReceipt = resolve(outputRoot, receiptOutput);
const outputTemporary = `${absoluteOutput}.tmp`;
const receiptTemporary = `${absoluteReceipt}.tmp`;
const buildKind = "esbuild-bundle-v1";
const requireBridge = "node-builtins-only-require-v1";
const runtimeFeatureGuard = "copilotkit-channels-disabled-v1";
const runtimeResolutionGuard = "node-builtins-only-v1";
const builderPackageIntegrity =
  "sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA==";
const reviewedBuilderBinaries = new Map([
  [
    "linux-x64",
    {
      packageName: "@esbuild/linux-x64",
      integrity:
        "sha512-4xTZr1FUmSoQW4XIWmit3tzQrUTZM+N3P0XV8xROKYF50XfI7xeO90+1bZvNwxIufQ9hDQVRJH5YhgPVF8A/HQ=="
    }
  ],
  [
    "win32-x64",
    {
      packageName: "@esbuild/win32-x64",
      integrity:
        "sha512-5ebpxr3nWMzrL/rnUI755Jkuee0bHL/Gq0WTF9lvcpv73wAp5eu8MfBUgWK9bhWvZjj7yX8etf/8tI8Ney695g=="
    }
  ]
]);
const allowedRuntimeExternals = new Set([
  ...builtinModules,
  ...builtinModules.map((value) => `node:${value}`)
]);
const guardedRequireBanner = [
  'import { createRequire as __createRequire } from "node:module";',
  `const __runtimeBuiltinModules = new Set(${JSON.stringify(
    [...allowedRuntimeExternals].sort()
  )});`,
  'function __rejectDynamicModuleResolution(specifier) { throw new Error(`Production runtime rejected dynamic module resolution: ${String(specifier)}`); }',
  "const __rawRuntimeRequire = __createRequire(import.meta.url);",
  "function require(specifier) { if (typeof specifier !== 'string' || !__runtimeBuiltinModules.has(specifier)) return __rejectDynamicModuleResolution(specifier); return __rawRuntimeRequire(specifier); }"
].join(" ");

const options = {
  absWorkingDir: repositoryRoot,
  banner: {
    js: guardedRequireBanner
  },
  bundle: true,
  charset: "utf8",
  entryPoints: [entrypoint],
  format: "esm",
  legalComments: "none",
  logLevel: "warning",
  metafile: true,
  outfile: absoluteOutput,
  packages: "bundle",
  platform: "node",
  sourcemap: false,
  target: "node22",
  write: false
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function replaceExactly(text, search, replacement, expectedCount) {
  const observedCount = text.split(search).length - 1;
  if (observedCount !== expectedCount) {
    throw new Error(
      `Reviewed runtime-resolution marker drifted: expected ${String(expectedCount)}, observed ${String(observedCount)} for ${search}.`
    );
  }
  return text.split(search).join(replacement);
}

function bundledOutput(result) {
  if (result.warnings.length !== 0) {
    throw new Error(
      `Production server bundling emitted warnings: ${result.warnings
        .map((warning) => warning.text)
        .join("; ")}`
    );
  }
  if (result.outputFiles?.length !== 1) {
    throw new Error("Production server bundling must emit exactly one JavaScript file.");
  }
  const externalImports = Object.values(result.metafile?.outputs ?? {})
    .flatMap((value) => value.imports ?? [])
    .filter((value) => value.external)
    .map((value) => value.path)
    .sort();
  const unsupported = externalImports.filter((value) => !allowedRuntimeExternals.has(value));
  if (unsupported.length > 0) {
    throw new Error(
      `Production bundle retained unsupported external packages: ${unsupported.join(", ")}`
    );
  }
  const text = Buffer.from(result.outputFiles[0].contents).toString("utf8");
  const guardedImport = "import(CHANNELS_INTELLIGENCE_SPECIFIER)";
  if (
    text.split(guardedImport).length - 1 !== 1 ||
    !text.includes("@copilotkit/channels-intelligence")
  ) {
    throw new Error(
      "The reviewed CopilotKit Channels computed-import boundary drifted and requires a bundle review."
    );
  }
  let hardened = replaceExactly(
    text,
    guardedImport,
    'Promise.reject(new Error("CopilotKit Channels are disabled in the reviewed production runtime."))',
    1
  );
  hardened = replaceExactly(
    hardened,
    "__require2 = /* @__PURE__ */ createRequire(import.meta.url);",
    "__require2 = require;",
    1
  );
  hardened = replaceExactly(
    hardened,
    "createRequire2(context2).resolve(origin)",
    "__rejectDynamicModuleResolution(origin)",
    1
  );
  hardened = replaceExactly(
    hardened,
    "createRequire2(getCurrentModulePath())(",
    "__rejectDynamicModuleResolution(",
    1
  );
  const expressRequireCount = hardened.split("__require(mod)").length - 1;
  const computedImportMatch = /(?<![.\w$])import\s*\(\s*(?!["'`])/u.exec(hardened);
  const computedImportRetained = computedImportMatch !== null;
  const generatedCreateRequireRetained = /\bcreateRequire2\s*\(/u.test(hardened);
  const bareCreateRequireRetained = /\bcreateRequire\s*\(/u.test(hardened);
  if (
    expressRequireCount !== 2 ||
    computedImportRetained ||
    generatedCreateRequireRetained ||
    bareCreateRequireRetained
  ) {
    throw new Error(
      `Production bundle retained an unreviewed computed module-resolution path: ${JSON.stringify({ expressRequireCount, computedImportRetained, computedImportContext: computedImportMatch === null ? null : hardened.slice(computedImportMatch.index, computedImportMatch.index + 160), generatedCreateRequireRetained, bareCreateRequireRetained })}.`
    );
  }
  return Buffer.from(hardened, "utf8");
}

await mkdir(dirname(absoluteOutput), { recursive: true });
try {
  if (process.version !== "v22.23.2") {
    throw new Error(
      `Production server bundling requires Node.js v22.23.2; observed ${process.version}.`
    );
  }
  const packageLock = JSON.parse(
    await readFile(resolve(repositoryRoot, "package-lock.json"), "utf8")
  );
  const builderPackage = packageLock.packages?.["node_modules/esbuild"];
  const builderBinary = reviewedBuilderBinaries.get(`${process.platform}-${process.arch}`);
  const builderBinaryPackage =
    builderBinary === undefined
      ? undefined
      : packageLock.packages?.[`node_modules/${builderBinary.packageName}`];
  if (
    packageLock.packages?.[""]?.devDependencies?.esbuild !== esbuildVersion ||
    builderPackage?.version !== esbuildVersion ||
    builderPackage?.integrity !== builderPackageIntegrity ||
    builderBinary === undefined ||
    builderBinaryPackage?.version !== esbuildVersion ||
    builderBinaryPackage?.integrity !== builderBinary.integrity
  ) {
    throw new Error(
      "package-lock.json does not provide the reviewed SRI-pinned esbuild wrapper and platform binary."
    );
  }
  const copilotRuntime = await readFile(resolve(repositoryRoot, copilotRuntimeOutput), "utf8");
  const channelActivationSettings = copilotRuntime.match(/\bactivateChannels:\s*(?:true|false)\b/gu);
  if (
    channelActivationSettings?.length !== 1 ||
    channelActivationSettings[0] !== "activateChannels: false"
  ) {
    throw new Error(
      "The self-contained production bundle requires CopilotKit Channels to remain explicitly disabled."
    );
  }
  const first = bundledOutput(await build(options));
  const second = bundledOutput(await build(options));
  const firstSha256 = sha256(first);
  const secondSha256 = sha256(second);
  if (firstSha256 !== secondSha256 || !Buffer.from(first).equals(Buffer.from(second))) {
    throw new Error("Production server bundle creation is not byte-for-byte deterministic.");
  }
  const receipt = {
    schemaVersion: 2,
    buildKind,
    builder: "esbuild",
    builderVersion: esbuildVersion,
    builderPackageIntegrity,
    builderBinaryPackage: builderBinary.packageName,
    builderBinaryIntegrity: builderBinary.integrity,
    entrypoint,
    output,
    platform: "node",
    format: "esm",
    target: "node22",
    nodeVersion: process.version,
    buildPlatform: process.platform,
    buildArchitecture: process.arch,
    requireBridge,
    runtimeFeatureGuard,
    runtimeResolutionGuard,
    bundleSha256: firstSha256,
    bundleBytes: first.byteLength
  };
  await writeFile(outputTemporary, first, { flag: "w" });
  await writeFile(receiptTemporary, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w"
  });
  await rm(absoluteReceipt, { force: true });
  await rm(absoluteOutput, { force: true });
  await rename(outputTemporary, absoluteOutput);
  await rename(receiptTemporary, absoluteReceipt);
  process.stdout.write(`${JSON.stringify({ accepted: true, ...receipt })}\n`);
} finally {
  await rm(outputTemporary, { force: true });
  await rm(receiptTemporary, { force: true });
}
