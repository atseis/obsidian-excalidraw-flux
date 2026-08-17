/*
# Batch Export WebP

Renders every Excalidraw drawing in the vault to a same-name WebP file using
the current Excalidraw Flux export configuration. Existing WebP files are
skipped. This script never modifies drawing Markdown or `img-view` references.

Run the script again while a batch is active to request cancellation.
*/

const STATE_KEY = "__excalidrawFluxBatchWebPState__";
const activeState = window[STATE_KEY];
if (activeState?.running) {
  activeState.cancelled = true;
  new Notice("Batch WebP export: cancellation requested. The current file will finish first.", 5000);
  return;
}

if (typeof ea.createWebP !== "function") {
  new Notice("Batch WebP export requires Excalidraw Flux 2.27.0-flux.20260817.8 or newer.", 8000);
  return;
}

const state = { running: true, cancelled: false };
window[STATE_KEY] = state;

const vaultApp = ea.plugin.app;
const settings = ea.plugin.settings;
const quality = clampNumber(settings.webpExportQuality, 0.5, 1, 0.8);
const defaultScale = clampNumber(settings.pngExportScale, 0.1, 10, 1);
const defaultPadding = clampNumber(settings.exportPaddingSVG, 0, 1000, 10);
const drawings = vaultApp.vault
  .getFiles()
  .filter((file) => ea.isExcalidrawFile(file))
  .sort((a, b) => a.path.localeCompare(b.path));

const jobs = drawings.map((file) => ({
  file,
  outputPath: replaceFinalExtension(file.path, "webp"),
}));
const existing = jobs.filter(({ outputPath }) =>
  vaultApp.vault.getAbstractFileByPath(outputPath),
);
const pending = jobs.filter(({ outputPath }) =>
  !vaultApp.vault.getAbstractFileByPath(outputPath),
);

const proceed = window.confirm(
  [
    "Batch export existing Excalidraw drawings to WebP?",
    "",
    `Detected drawings: ${jobs.length}`,
    `New WebP files to create: ${pending.length}`,
    `Existing same-name paths to skip: ${existing.length}`,
    `Quality: ${quality}`,
    `Default scale: ${defaultScale}`,
    `Default padding: ${defaultPadding}`,
    `Background: ${settings.exportWithBackground ? "on" : "off"}`,
    `Theme colors: ${settings.exportWithTheme ? "on" : "off"}`,
    "",
    "No Markdown, drawing data, SVG file, or img-view reference will be modified.",
  ].join("\n"),
);

if (!proceed) {
  delete window[STATE_KEY];
  return;
}

ea.clear();
const startedAt = new Date();
const created = [];
const skipped = existing.map(({ file, outputPath }) => ({
  drawing: file.path,
  output: outputPath,
  reason: "already exists",
}));
const failed = [];

try {
  for (let index = 0; index < pending.length; index++) {
    if (state.cancelled) break;
    const { file, outputPath } = pending[index];
    try {
      const options = getFileExportOptions(file);
      const blob = await ea.createWebP(
        file.path,
        options.scale,
        options.exportSettings,
        undefined,
        options.theme,
        options.padding,
        quality,
      );
      if (!blob || blob.type !== "image/webp") {
        throw new Error(`encoder returned ${blob?.type || "no blob"}`);
      }
      const data = await blob.arrayBuffer();
      assertWebP(data, "encoded blob");
      const createdFile = await vaultApp.vault.createBinary(outputPath, data);
      const savedData = await vaultApp.vault.readBinary(createdFile);
      assertWebP(savedData, "saved file");
      created.push({
        drawing: file.path,
        output: outputPath,
        bytes: savedData.byteLength,
        scale: options.scale,
        padding: options.padding,
        theme: options.theme || "drawing",
        background: options.exportSettings.withBackground,
      });
    } catch (error) {
      failed.push({
        drawing: file.path,
        output: outputPath,
        error: error?.message || String(error),
      });
      console.error("Batch WebP export failed", file.path, error);
    }

    if ((index + 1) % 20 === 0 || index + 1 === pending.length) {
      new Notice(
        `Batch WebP export: ${index + 1}/${pending.length}; created ${created.length}; failed ${failed.length}.`,
        2200,
      );
      await yieldToUI();
    }
  }
} finally {
  state.running = false;
  delete window[STATE_KEY];
}

const finishedAt = new Date();
const reportPath = await writeReport({
  startedAt,
  finishedAt,
  cancelled: state.cancelled,
  settings: {
    quality,
    defaultScale,
    defaultPadding,
    exportWithBackground: !!settings.exportWithBackground,
    exportWithTheme: !!settings.exportWithTheme,
  },
  detected: jobs.length,
  created,
  skipped,
  failed,
});

new Notice(
  `Batch WebP export ${state.cancelled ? "cancelled" : "finished"}: created ${created.length}, skipped ${skipped.length}, failed ${failed.length}. Report: ${reportPath}`,
  12000,
);

function getFileExportOptions(file) {
  const frontmatter =
    vaultApp.metadataCache.getFileCache(file)?.frontmatter || {};
  const transparent = optionalBoolean(
    frontmatter["excalidraw-export-transparent"],
  );
  const dark = optionalBoolean(frontmatter["excalidraw-export-dark"]);
  const scale = clampNumber(
    frontmatter["excalidraw-export-pngscale"],
    0.1,
    10,
    defaultScale,
  );
  const padding = clampNumber(
    frontmatter["excalidraw-export-padding"],
    0,
    1000,
    defaultPadding,
  );
  const withBackground =
    transparent === undefined
      ? !!settings.exportWithBackground
      : !transparent;
  const theme = dark === undefined ? undefined : dark ? "dark" : "light";
  return {
    scale,
    padding,
    theme,
    exportSettings: ea.getExportSettings(
      withBackground,
      !!settings.exportWithTheme,
      !!ea.isExcalidrawMaskFile(file),
    ),
  };
}

function replaceFinalExtension(filePath, extension) {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return `${filePath}.${extension}`;
  return `${filePath.slice(0, dot)}.${extension}`;
}

function optionalBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function assertWebP(buffer, source) {
  const bytes = new Uint8Array(buffer);
  const signature = (start, text) =>
    [...text].every((character, offset) =>
      bytes[start + offset] === character.charCodeAt(0),
    );
  if (
    bytes.byteLength < 12 ||
    !signature(0, "RIFF") ||
    !signature(8, "WEBP")
  ) {
    throw new Error(`${source} is not a valid RIFF WebP file`);
  }
}

async function yieldToUI() {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function ensureFolder(folderPath) {
  const segments = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!vaultApp.vault.getAbstractFileByPath(current)) {
      await vaultApp.vault.createFolder(current);
    }
  }
}

async function writeReport(data) {
  const folder = "plugins/Excalidraw/Reports";
  await ensureFolder(folder);
  const stamp = data.startedAt
    .toISOString()
    .replace(/[:.]/g, "-");
  const reportPath = `${folder}/Batch WebP Export ${stamp}.md`;
  const lines = [
    "# Batch WebP Export Report",
    "",
    `- Started: ${data.startedAt.toISOString()}`,
    `- Finished: ${data.finishedAt.toISOString()}`,
    `- Cancelled: ${data.cancelled}`,
    `- Detected drawings: ${data.detected}`,
    `- Created: ${data.created.length}`,
    `- Skipped existing: ${data.skipped.length}`,
    `- Failed: ${data.failed.length}`,
    `- Quality: ${data.settings.quality}`,
    `- Default scale: ${data.settings.defaultScale}`,
    `- Default padding: ${data.settings.defaultPadding}`,
    `- Background: ${data.settings.exportWithBackground}`,
    `- Theme colors: ${data.settings.exportWithTheme}`,
    "",
    "> This run did not modify Markdown files, SVG files, drawing data, or img-view references.",
    "",
    "## Created",
    "",
    ...data.created.map(
      (item) =>
        `- \`${item.output}\` — ${item.bytes} bytes; source \`${item.drawing}\`; scale ${item.scale}; padding ${item.padding}; theme ${item.theme}; background ${item.background}`,
    ),
    "",
    "## Skipped existing",
    "",
    ...data.skipped.map(
      (item) => `- \`${item.output}\` — source \`${item.drawing}\``,
    ),
    "",
    "## Failed",
    "",
    ...data.failed.map(
      (item) =>
        `- \`${item.drawing}\` → \`${item.output}\`: ${item.error}`,
    ),
    "",
  ];
  await vaultApp.vault.create(reportPath, lines.join("\n"));
  return reportPath;
}
