import type { Packages } from "src/types/types";
import { Notice, normalizePath, TFile } from "obsidian";
import {
  CJK_STYLE_ID,
  DEVICE,
  FONTS_STYLE_ID,
} from "src/constants/constants";
import { t } from "src/lang/helpers";
import { getCJKDataURLs } from "src/utils/CJKLoader";
import { getFontDataURL } from "src/utils/utils";
import { getFontMetrics } from "src/utils/fontMetrics";
import type ExcalidrawPlugin from "src/core/main";

declare const mainDocument: Document;
declare const deliberateCreateElement: (
  document: Document,
  tagName: string,
) => HTMLStyleElement;

type PackageMapProvider = () => Map<Window, Packages>;

const VAULT_FONT_EXTENSIONS = new Set(["otf", "ttf", "woff", "woff2"]);
const CUSTOM_FONT_ID_OFFSET = 10_000;

const getStableCustomFontId = (family: string): number => {
  // FNV-1a keeps the serialized numeric id stable across vaults and machines.
  let hash = 0x811c9dc5;
  for (const character of family.normalize("NFC").toLocaleLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return CUSTOM_FONT_ID_OFFSET + (hash >>> 0);
};

const quoteCSSFontFamily = (family: string): string =>
  `"${family.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * Owns CJK and custom-font discovery, registration, document stylesheets, and
 * readiness state while preserving the plugin's existing public font facade.
 */
export class FontManager {
  private isLocalCJKFontAvailabe: boolean = undefined;
  // Intentionally true to preserve the existing startup race behavior.
  private fontsReady = true;

  public constructor(
    private readonly plugin: ExcalidrawPlugin,
    private readonly getPackageMap: PackageMapProvider,
  ) {}

  /** Whether font initialization permits the plugin readiness wait to finish. */
  public get isReady(): boolean {
    return this.fontsReady;
  }

  /** Returns the enabled CJK ranges when local CJK font assets are available. */
  public getCJKFontSettings(): { c: boolean; j: boolean; k: boolean } {
    const assetsFoler = this.plugin.settings.fontAssetsPath;
    if (typeof this.isLocalCJKFontAvailabe === "undefined") {
      this.isLocalCJKFontAvailabe = this.plugin.app.vault
        .getFiles()
        .some((file) => file.path.startsWith(assetsFoler));
    }
    if (!this.isLocalCJKFontAvailabe) {
      return { c: false, j: false, k: false };
    }
    return {
      c: this.plugin.settings.loadChineseFonts,
      j: this.plugin.settings.loadJapaneseFonts,
      k: this.plugin.settings.loadKoreanFonts,
    };
  }

  /** Reads a configured CJK font asset from the vault. */
  public async loadFontFromFile(
    fontName: string,
  ): Promise<ArrayBuffer | undefined> {
    const assetsFoler = this.plugin.settings.fontAssetsPath;

    if (!this.isLocalCJKFontAvailabe) {
      return;
    }
    const file = this.plugin.app.vault.getFileByPath(
      normalizePath(`${assetsFoler}/${fontName}`),
    );
    if (!file || !(file instanceof TFile)) {
      return;
    }
    return await this.plugin.app.vault.readBinary(file);
  }

  /**
   * Loads configured CJK and custom fonts into every open Obsidian document
   * and registers custom font metrics with each window-scoped Excalidraw package.
   */
  public async initializeFonts(): Promise<void> {
    const cjkFontDataURLs = await getCJKDataURLs(this.plugin);
    if (typeof cjkFontDataURLs === "boolean" && !cjkFontDataURLs) {
      new Notice(
        t("FONTS_LOAD_ERROR") + this.plugin.settings.fontAssetsPath,
        6000,
      );
    }

    if (typeof cjkFontDataURLs === "object") {
      const fontDeclarations = cjkFontDataURLs.map(
        (dataURL) =>
          `@font-face { font-family: 'Xiaolai'; src: url("${dataURL}"); font-display: swap; font-weight: 400; }`,
      );
      for (const ownerDocument of this.getOpenObsidianDocuments()) {
        await this.addFonts(fontDeclarations, ownerDocument, CJK_STYLE_ID);
      }
      new Notice(t("FONTS_LOADED"));
    }

    const customFontDeclarations = await this.initializeMultiFonts();
    const font = await getFontDataURL(
      this.plugin.app,
      this.plugin.settings.experimantalFourthFont,
      "",
      "Local Font",
    );

    if (font.dataURL === "") {
      this.plugin.fourthFontLoaded = true;
    } else {
      const fourthFontDataURL = font.dataURL;
      const file = this.plugin.app.metadataCache.getFirstLinkpathDest(
        this.plugin.settings.experimantalFourthFont,
        "",
      );
      let fontMetrics =
        !file || file.extension.startsWith("woff") || !font.arrayBuffer
          ? undefined
          : getFontMetrics(font.arrayBuffer);

      if (!fontMetrics) {
        fontMetrics = {
          unitsPerEm: 1000,
          ascender: 750,
          descender: -250,
          lineHeight: 1.2,
        };
      }
      this.getPackageMap().forEach(({ excalidrawLib }) => {
        excalidrawLib?.registerLocalFont(
          { metrics: fontMetrics },
          fourthFontDataURL,
        );
      });
      customFontDeclarations.push(
        `@font-face{font-family:'Local Font';src:url("${fourthFontDataURL}");font-display:swap;font-weight:400;}`,
      );
    }

    for (const ownerDocument of this.getOpenObsidianDocuments()) {
      await this.addFonts(customFontDeclarations, ownerDocument);
    }
    if (!this.plugin.fourthFontLoaded) {
      window.setTimeout(() => {
        this.plugin.fourthFontLoaded = true;
      }, 100);
    }
    this.fontsReady = true;
  }

  /** Registers every supported font directly below the YMJR multi-font folder. */
  private async initializeMultiFonts(): Promise<string[]> {
    const configuredFolder = this.plugin.settings.multiFontsFolder?.trim();
    if (!configuredFolder) {
      return [];
    }

    const folder = normalizePath(configuredFolder);
    const prefix = folder.endsWith("/") ? folder : `${folder}/`;
    const fontFiles = this.plugin.app.vault
      .getFiles()
      .filter(
        (file) =>
          file.path.startsWith(prefix) &&
          !file.path.slice(prefix.length).includes("/") &&
          VAULT_FONT_EXTENSIONS.has(file.extension.toLocaleLowerCase()),
      )
      .sort((left, right) => left.path.localeCompare(right.path));

    const declarations: string[] = [];
    const claimedIds = new Map<number, string>();
    const claimedFamilies = new Set<string>();
    for (const file of fontFiles) {
      const family = file.basename.normalize("NFC").trim();
      if (!family || claimedFamilies.has(family)) {
        console.warn(`Skipped duplicate Excalidraw vault font: ${file.path}`);
        continue;
      }

      let familyId = getStableCustomFontId(family);
      while (claimedIds.has(familyId) && claimedIds.get(familyId) !== family) {
        familyId += 1;
      }
      claimedIds.set(familyId, family);
      claimedFamilies.add(family);

      const font = await getFontDataURL(this.plugin.app, file.path, "", family);
      if (!font.dataURL) {
        console.warn(`Unable to load Excalidraw vault font: ${file.path}`);
        continue;
      }

      const parsedMetrics =
        file.extension.toLocaleLowerCase().startsWith("woff") ||
        !font.arrayBuffer
          ? null
          : getFontMetrics(font.arrayBuffer);
      const metrics = parsedMetrics ?? {
        unitsPerEm: 1000 as const,
        ascender: 750,
        descender: -250,
        lineHeight: 1.2,
      };
      this.getPackageMap().forEach(({ excalidrawLib }) => {
        excalidrawLib?.registerCustomFont(
          family,
          familyId,
          { metrics },
          font.dataURL,
        );
      });
      declarations.push(
        `@font-face{font-family:${quoteCSSFontFamily(family)};src:url("${font.dataURL}");font-display:swap;font-weight:400;}`,
      );
    }
    return declarations;
  }

  /** Replaces a plugin-owned font stylesheet and waits for the font to load. */
  public async addFonts(
    declarations: string[],
    ownerDocument: Document = mainDocument,
    styleId: string = FONTS_STYLE_ID,
  ): Promise<void> {
    const newStylesheet = deliberateCreateElement(ownerDocument, "style");
    newStylesheet.id = styleId;
    newStylesheet.textContent = declarations.join("");
    const oldStylesheet = ownerDocument.getElementById(styleId);
    ownerDocument.head.appendChild(newStylesheet);
    if (oldStylesheet) {
      ownerDocument.head.removeChild(oldStylesheet);
    }
    await ownerDocument.fonts.load("20px Local Font");
  }

  /** Removes custom and CJK font stylesheets from all open documents. */
  public removeFonts(): void {
    this.getOpenObsidianDocuments().forEach((ownerDocument) => {
      const oldCustomFontStylesheet =
        ownerDocument.getElementById(FONTS_STYLE_ID);
      if (oldCustomFontStylesheet) {
        ownerDocument.head.removeChild(oldCustomFontStylesheet);
      }
      const oldCJKFontStylesheet = ownerDocument.getElementById(CJK_STYLE_ID);
      if (oldCJKFontStylesheet) {
        ownerDocument.head.removeChild(oldCJKFontStylesheet);
      }
    });
  }

  private getOpenObsidianDocuments(): Document[] {
    const visitedDocuments = new Set<Document>();
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      const ownerDocument = DEVICE.isMobile
        ? mainDocument
        : leaf.view.containerEl.ownerDocument;
      if (!ownerDocument || visitedDocuments.has(ownerDocument)) {
        return;
      }
      visitedDocuments.add(ownerDocument);
    });
    return Array.from(visitedDocuments);
  }
}
