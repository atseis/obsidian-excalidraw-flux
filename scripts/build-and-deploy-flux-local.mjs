#!/usr/bin/env node

/**
 * Builds the local Excalidraw Flux distribution and deploys it to the
 * dedicated obsidian-test vault. The vault allow-list is deliberately fixed
 * so this command cannot overwrite the user's HyperFlux plugin.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreRoot = resolve(pluginRoot, "../zsviczian-excalidraw-ymjr-rebuild");
const allowedVault = "/home/wy/文档/obsidian-test";
const pluginId = "obsidian-excalidraw-plugin";
const targetDir = join(allowedVault, ".obsidian/plugins", pluginId);
const installedCoreDir = join(
  pluginRoot,
  "node_modules/@zsviczian/excalidraw/dist/obsidian",
);
const builtCoreDir = join(coreRoot, "packages/excalidraw/dist/obsidian");
const coreArtifacts = [
  "excalidraw.production.min.js",
  "excalidraw.production.min.css",
  "excalidraw.development.js",
  "excalidraw.development.css",
];
const pluginArtifacts = ["main.js", "styles.css", "manifest.json"];

const args = process.argv.slice(2);
const versionIndex = args.indexOf("--version");
const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined;

if (!version || !/^\d+\.\d+\.\d+-flux\.\d{8}\.\d+$/.test(version)) {
  throw new Error(
    "Usage: node scripts/build-and-deploy-flux-local.mjs --version 2.27.0-flux.YYYYMMDD.N",
  );
}
if (!existsSync(coreRoot)) {
  throw new Error(`Core fork not found: ${coreRoot}`);
}
if (!existsSync(join(targetDir, "manifest.json"))) {
  throw new Error(`Test plugin target not found: ${targetDir}`);
}
if (targetDir.includes("HyperFlux") || allowedVault.includes("HyperFlux")) {
  throw new Error("Refusing to deploy into HyperFlux");
}
const deployedManifest = JSON.parse(
  readFileSync(join(targetDir, "manifest.json"), "utf8"),
);
if (deployedManifest.version === version) {
  throw new Error(
    `Version ${version} is already deployed; use a new local version`,
  );
}

const run = (command, commandArgs, cwd) => {
  console.log(`\n> ${command} ${commandArgs.join(" ")}`);
  execFileSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
};

const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const assertSameFile = (left, right) => {
  const leftHash = sha256(left);
  const rightHash = sha256(right);
  if (leftHash !== rightHash) {
    throw new Error(`Artifact mismatch:\n${left}\n${right}`);
  }
  console.log(`${leftHash}  ${right}`);
};

const updateManifestVersion = (filename) => {
  const path = join(pluginRoot, filename);
  const original = readFileSync(path, "utf8");
  const manifest = JSON.parse(original);
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  manifest.version = version;
  writeFileSync(
    path,
    `${JSON.stringify(manifest, null, 2).replace(/\n/g, eol)}${eol}`,
  );
};

updateManifestVersion("manifest.json");
updateManifestVersion("manifest-beta.json");

run(
  "corepack",
  [
    "yarn",
    "test:app",
    "packages/element/src/__tests__/ymjrArrowFeatures.test.ts",
    "packages/excalidraw/tests/ymjrArrowFeatures.test.tsx",
    "packages/excalidraw/tests/ymjrFontFeatures.test.ts",
    "packages/common/src/utils.test.ts",
    "packages/excalidraw/tests/colorPickerHotkeys.test.ts",
    "packages/common/src/colors.test.ts",
    "--run",
  ],
  coreRoot,
);
run(
  "corepack",
  ["yarn", "--cwd", "packages/excalidraw", "build:obsidian"],
  coreRoot,
);
// Restore the locked official package, then replace only the four Obsidian
// consumer artifacts with the freshly built local Flux Core. This mirrors the
// public release workflow without keeping a generated Core tarball in Git.
run("npm", ["install"], pluginRoot);
for (const artifact of coreArtifacts) {
  const source = join(builtCoreDir, artifact);
  const target = join(installedCoreDir, artifact);
  copyFileSync(source, target);
  assertSameFile(source, target);
}

run("npm", ["run", "build"], pluginRoot);

const builtManifest = JSON.parse(
  readFileSync(join(pluginRoot, "dist/manifest.json"), "utf8"),
);
if (builtManifest.id !== pluginId || builtManifest.version !== version) {
  throw new Error(
    `Unexpected built manifest: ${builtManifest.id} ${builtManifest.version}`,
  );
}
const builtMain = readFileSync(join(pluginRoot, "dist/main.js"), "utf8");
if (!builtMain.includes(`const PLUGIN_VERSION="${version}";`)) {
  throw new Error("main.js does not contain the requested local version");
}

const dataPath = join(targetDir, "data.json");
const dataHashBefore = existsSync(dataPath) ? sha256(dataPath) : null;
for (const artifact of pluginArtifacts) {
  const source = join(pluginRoot, "dist", artifact);
  const target = join(targetDir, artifact);
  copyFileSync(source, target);
  assertSameFile(source, target);
}
if (dataHashBefore && sha256(dataPath) !== dataHashBefore) {
  throw new Error("Deployment unexpectedly changed data.json");
}

run(
  "obsidian",
  ["vault=obsidian-test", "plugin:reload", `id=${pluginId}`],
  allowedVault,
);
run(
  "obsidian",
  ["vault=obsidian-test", "plugin", `id=${pluginId}`],
  allowedVault,
);

console.log(`\nDeployed ${version} to ${targetDir}`);
