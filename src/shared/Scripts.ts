import {
  App,
  Instruction,
  Notice,
  normalizePath,
  TAbstractFile,
  TFile,
} from "obsidian";
import { PLUGIN_ID } from "../constants/constants";
import ExcalidrawView from "../view/ExcalidrawView";
import ExcalidrawPlugin from "../core/main";
import { GenericInputPrompt, GenericSuggester } from "./Dialogs/Prompt";
import { getIMGFilename } from "../utils/fileUtils";
import { splitFolderAndFilename } from "../utils/fileUtils";
import { getEA } from "src/core";
import { ExcalidrawAutomate } from "../shared/ExcalidrawAutomate";
import { WeakArray } from "./WeakArray";
import {
  getExcalidrawViews,
  stripYamlFrontmatter,
} from "../utils/obsidianUtils";
import { ButtonDefinition, InputPromptOptions } from "src/types/promptTypes";
import { errorlog } from "src/utils/coreUtils";
import { wrapTextAtCharLength } from "../utils/textUtils";
import { prepareLegacyYmjrScript } from "./legacyYmjrScriptCompatibility";

export type ScriptIconMap = {
  [key: string]: { name: string; group: string; svgString: string };
};

type LegacyYmjrEaTools = Record<string, unknown> & {
  wrapTextAtCharLength?: typeof wrapTextAtCharLength;
};

export class ScriptEngine {
  private plugin: ExcalidrawPlugin;
  private app: App;
  private scriptPath: string;
  /**
   * YMJR treated scripts named `autorun*`/`_autorun*` (or carrying
   * `autorun: true` frontmatter) as one-time global initialization scripts.
   * Keep the flag on the engine so opening additional drawings does not
   * install the same hooks and ExcalidrawAutomate helpers repeatedly.
   */
  private legacyYmjrGlobalAutorunExecuted = false;
  /**
   * Legacy autorun helpers close over the EA instance that installed them.
   * Keep those instances alive for the plugin session and retarget them as
   * drawings change so the unchanged helper functions always see a live API.
   */
  private legacyYmjrAutorunEAs = new Set<ExcalidrawAutomate>();
  //https://stackoverflow.com/questions/60218638/how-to-force-re-render-if-map-value-changes
  public scriptIconMap: ScriptIconMap;
  eaInstances = new WeakArray<ExcalidrawAutomate>();
  /**
   * Selected-element action-provider unregister callbacks registered via
   * `ExcalidrawAutomate.registerElementActionProvider()`, keyed by script
   * name. Cleared in `unloadScript()` so a deleted script's buttons don't
   * linger in views that are still open.
   */
  private elementActionProviders = new Map<string, Set<() => void>>();

  constructor(plugin: ExcalidrawPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.scriptIconMap = {};
    this.loadScripts();
    this.registerEventHandlers();
  }

  public removeViewEAs(view: ExcalidrawView) {
    const eas = new Set<ExcalidrawAutomate>();
    this.eaInstances.forEach((ea) => {
      if (ea.targetView === view) {
        eas.add(ea);
        if (ea.sidepanelTab) {
          ea.targetView = null;
          ea.sidepanelTab.onExcalidrawViewClosed();
        } else {
          ea.destroy();
        }
      }
    });
    this.eaInstances.removeObjects(eas);

    const fallbackView = getExcalidrawViews(this.app, true).find(
      (candidate) => candidate !== view,
    );
    this.legacyYmjrAutorunEAs.forEach((ea) => {
      if (ea.targetView === view) {
        ea.targetView = fallbackView ?? null;
      }
    });
    // HyperFlux's obfuscated `_autorun-utils.md` closes over the shared
    // window.ExcalidrawAutomate object for several helpers, including
    // updateSceneByZoom. Retarget that global EA as well when its view closes.
    if (this.plugin.ea?.targetView === view) {
      this.plugin.ea.targetView = fallbackView ?? null;
    }
  }

  public destroy() {
    this.eaInstances.forEach((ea) => ea.destroy());
    this.eaInstances.clear();
    this.eaInstances = null;
    this.legacyYmjrAutorunEAs.forEach((ea) => ea.destroy());
    this.legacyYmjrAutorunEAs.clear();
    this.elementActionProviders.clear();
    this.scriptIconMap = null;
    this.plugin = null;
    this.scriptPath = null;
  }

  private handleSvgFileChange(path: string) {
    if (!path.endsWith(".svg")) {
      return;
    }
    const scriptFile = this.app.vault.getAbstractFileByPath(
      getIMGFilename(path, "md"),
    );
    if (scriptFile && scriptFile instanceof TFile) {
      this.unloadScript(this.getScriptName(scriptFile), scriptFile.path);
      this.loadScript(scriptFile);
    }
  }

  private async deleteEventHandler(file: TFile) {
    if (!(file instanceof TFile)) {
      return;
    }
    if (!file.path.startsWith(this.scriptPath)) {
      return;
    }
    const scriptName = this.getScriptName(file);
    this.unloadScript(scriptName, file.path);
    await this.purgeAutostartPermission(scriptName);
    this.handleSvgFileChange(file.path);
  }

  private async createEventHandler(file: TFile) {
    if (!(file instanceof TFile)) {
      return;
    }
    if (!file.path.startsWith(this.scriptPath)) {
      return;
    }
    this.loadScript(file);
    this.handleSvgFileChange(file.path);
  }

  private async renameEventHandler(file: TAbstractFile, oldPath: string) {
    if (!(file instanceof TFile)) {
      return;
    }
    const oldFileIsScript = oldPath.startsWith(this.scriptPath);
    const newFileIsScript = file.path.startsWith(this.scriptPath);
    if (oldFileIsScript) {
      const oldScriptName = this.getScriptName(oldPath);
      this.unloadScript(oldScriptName, oldPath);
      await this.purgeAutostartPermission(oldScriptName);
      this.handleSvgFileChange(oldPath);
    }
    if (newFileIsScript) {
      this.loadScript(file);
      this.handleSvgFileChange(file.path);
    }
  }

  registerEventHandlers() {
    this.plugin.registerEvent(
      this.app.vault.on("delete", (file: TFile) =>
        this.deleteEventHandler(file),
      ),
    );
    this.plugin.registerEvent(
      this.app.vault.on("create", (file: TFile) =>
        this.createEventHandler(file),
      ),
    );
    this.plugin.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) =>
        this.renameEventHandler(file, oldPath),
      ),
    );
  }

  updateScriptPath() {
    if (this.scriptPath === this.plugin.settings.scriptFolderPath) {
      return;
    }
    if (this.scriptPath) {
      this.unloadScripts();
    }
    this.loadScripts();
  }

  public getListofScripts(): TFile[] {
    this.scriptPath = this.plugin.settings.scriptFolderPath;
    if (!this.scriptPath) {
      return;
    }
    this.scriptPath = normalizePath(this.scriptPath);
    if (!this.app.vault.getAbstractFileByPath(this.scriptPath)) {
      return;
    }
    return this.app.vault
      .getFiles()
      .filter(
        (f: TFile) =>
          f.path.startsWith(`${this.scriptPath}/`) && f.extension === "md",
      );
  }

  loadScripts() {
    this.getListofScripts()?.forEach((f) => this.loadScript(f));
  }

  /**
   * Runs the legacy YMJR global autorun convention once for the active plugin
   * session. HyperFlux uses this mechanism to install shared script helpers
   * such as `ExcalidrawAutomate.tools` before user-invoked scripts call them.
   *
   * This remains behind the existing "Enable onload scripts" permission in
   * ExcalidrawView. Only local files from the configured script folder are
   * read and passed through the normal script runner (including `//ymjr`
   * compatibility decoding); no remote code is fetched.
   */
  public async runLegacyYmjrAutorunScripts(view: ExcalidrawView) {
    if (!view) {
      return;
    }

    this.rebindLegacyYmjrAutorunEAs(view);
    if (this.legacyYmjrGlobalAutorunExecuted) {
      return;
    }

    this.legacyYmjrGlobalAutorunExecuted = true;
    const scriptPath = normalizePath(this.plugin.settings.scriptFolderPath);
    const isAutorunScript = (file: TFile): boolean => {
      const cache = this.app.metadataCache.getFileCache(file);
      return (
        cache?.frontmatter?.autorun === true ||
        file.basename.startsWith("autorun") ||
        file.basename.startsWith("_autorun")
      );
    };
    const autorunScripts = this.app.vault
      .getFiles()
      .filter(
        (file) =>
          file.extension === "md" &&
          file.path.startsWith(`${scriptPath}/`) &&
          !file.path.includes("node_modules") &&
          !file.path.includes("temp_encrypt") &&
          isAutorunScript(file),
      );

    for (const file of autorunScripts) {
      try {
        const script = await this.app.vault.read(file);
        await this.executeScript(
          view,
          script,
          this.getScriptName(file),
          file,
          true,
        );
      } catch (error) {
        errorlog({
          where: "ScriptEngine.runLegacyYmjrAutorunScripts",
          message: `Could not run legacy YMJR autorun script: ${file.path}`,
          error,
        });
      }
    }
  }

  public getScriptName(f: TFile | string): string {
    let basename = "";
    let path = "";
    if (f instanceof TFile) {
      basename = f.basename;
      path = f.path;
    } else {
      basename = splitFolderAndFilename(f).basename;
      path = f;
    }

    const subpath = path.split(`${this.scriptPath}/`)[1];
    if (!subpath) {
      console.warn(
        `ScriptEngine.getScriptName unexpected basename: ${basename}; path: ${path}`,
      );
    }
    const lastSlash = subpath?.lastIndexOf("/");
    if (lastSlash > -1) {
      return subpath.substring(0, lastSlash + 1) + basename;
    }
    return basename;
  }

  public getScriptFileByName(scriptName: string): TFile | null {
    return (
      this.getListofScripts()?.find(
        (file) => this.getScriptName(file) === scriptName,
      ) ?? null
    );
  }

  async addScriptIconToMap(scriptPath: string, name: string) {
    const svgFilePath = getIMGFilename(scriptPath, "svg");
    const file = this.app.vault.getAbstractFileByPath(svgFilePath);
    const svgString: string =
      file && file instanceof TFile ? await this.app.vault.read(file) : null;
    this.scriptIconMap = {
      ...this.scriptIconMap,
    };
    const splitname = splitFolderAndFilename(name);
    this.scriptIconMap[scriptPath] = {
      name: splitname.filename,
      group: splitname.folderpath,
      svgString,
    };
    this.updateToolPannels();
  }

  loadScript(f: TFile) {
    if (f.extension !== "md") {
      return;
    }
    const scriptName = this.getScriptName(f);
    void this.addScriptIconToMap(f.path, scriptName);
    this.plugin.addCommand({
      id: scriptName,
      name: `(Script) ${scriptName}`,
      checkCallback: (checking: boolean) => {
        if (checking) {
          return Boolean(
            this.app.workspace.getActiveViewOfType(ExcalidrawView),
          );
        }
        const view = this.app.workspace.getActiveViewOfType(ExcalidrawView);
        if (view) {
          void (async () => {
            const script = stripYamlFrontmatter(await this.app.vault.read(f));
            if (script) {
              await this.executeScript(view, script, scriptName, f);
            }
          })();
          return true;
        }
        return false;
      },
    });
  }

  unloadScripts() {
    const scripts = this.app.vault
      .getFiles()
      .filter((f: TFile) => f.path.startsWith(this.scriptPath));
    scripts.forEach((f) => {
      this.unloadScript(this.getScriptName(f), f.path);
    });
  }

  /**
   * Registers a cleanup callback for a selected-element action provider a
   * script registered via `ExcalidrawAutomate.registerElementActionProvider()`,
   * so it can be unregistered if the script's file is deleted while a view
   * using it is still open. Not needed for the ordinary view-close case,
   * which `SelectedElementActionsMenu.destroy()` already handles.
   */
  public trackElementActionProvider(
    scriptName: string,
    unregister: () => void,
  ): void {
    let providers = this.elementActionProviders.get(scriptName);
    if (!providers) {
      providers = new Set();
      this.elementActionProviders.set(scriptName, providers);
    }
    providers.add(unregister);
  }

  /**
   * Removes a script's entry from `settings.autostartScripts` and
   * `settings.autostartScriptFailures` when its file is deleted or renamed
   * away, so a stale allow/deny permission or failure flag does not linger
   * under a name that no longer resolves to any script file. A renamed
   * script starts fresh (prompts again) under its new name.
   */
  private async purgeAutostartPermission(scriptName: string): Promise<void> {
    const hasPermission = scriptName in this.plugin.settings.autostartScripts;
    const hasFailureFlag =
      scriptName in this.plugin.settings.autostartScriptFailures;
    if (!hasPermission && !hasFailureFlag) {
      return;
    }
    delete this.plugin.settings.autostartScripts[scriptName];
    delete this.plugin.settings.autostartScriptFailures[scriptName];
    await this.plugin.saveSettings();
  }

  /**
   * Records whether a script's most recent autostart run failed, so it can
   * be surfaced as a warning in the autostart settings/modal UI. Only
   * writes to disk when the flag actually changes (not on every autostart
   * run) to avoid a `saveSettings()` call every time an allow-listed
   * script runs. Purely informational: never touches `autostartScripts`
   * itself, so a failing script is never auto-removed from the allow
   * list - the user does that manually.
   */
  private async recordAutostartResult(
    scriptName: string,
    failed: boolean,
  ): Promise<void> {
    const failures = this.plugin.settings.autostartScriptFailures;
    if (Boolean(failures[scriptName]) === failed) {
      return;
    }
    if (failed) {
      failures[scriptName] = true;
    } else {
      delete failures[scriptName];
    }
    await this.plugin.saveSettings();
  }

  /**
   * Reads and executes a single autostart-permitted script against a single
   * view, catching and logging its own error so one bad script never
   * affects the caller's other scripts/views. Shared by
   * `attachAutostartScriptToOpenViews()` and `runAutostartScripts()`.
   */
  private async runAutostartScriptInView(
    scriptName: string,
    file: TFile,
    view: ExcalidrawView,
    where: string,
  ): Promise<void> {
    try {
      const script = stripYamlFrontmatter(await this.app.vault.read(file));
      if (script) {
        await this.executeScript(view, script, scriptName, file);
      }
      await this.recordAutostartResult(scriptName, false);
    } catch (error: unknown) {
      errorlog({ where, scriptName, error });
      await this.recordAutostartResult(scriptName, true);
    }
  }

  /**
   * Called by `ExcalidrawAutomate.registerAutostart()` right after a script
   * is freshly granted autostart permission, so the script attaches to
   * every other currently-open Excalidraw view immediately instead of only
   * the next time each view is opened. Reuses the same `executeScript()`
   * path `runAutostartScripts()` uses for newly-opened views; one script
   * failing does not affect the others.
   */
  public attachAutostartScriptToOpenViews(
    scriptName: string,
    excludeView?: ExcalidrawView,
  ): void {
    const file = this.getScriptFileByName(scriptName);
    if (!file) {
      return;
    }
    const views = getExcalidrawViews(this.app, true).filter(
      (view) => view !== excludeView,
    );
    views.forEach((view) => {
      void this.runAutostartScriptInView(
        scriptName,
        file,
        view,
        "ScriptEngine.attachAutostartScriptToOpenViews",
      );
    });
  }

  /**
   * Runs every script the user has allow-listed for autostart (see
   * `ExcalidrawAutomate.registerAutostart()`) once against a newly-opened
   * view. Called from `ExcalidrawRoot.ts`'s mount effect, after the view's
   * `selectedElementActionsMenu` is ready. Fire-and-forget: does not block
   * initial render. Deliberately independent of the sidepanel autostart
   * feature (`Sidepanel.ts`, not touched) — different persisted field,
   * different trigger, different execution owner.
   */
  public runAutostartScripts(view: ExcalidrawView): void {
    const autostartScripts = this.plugin.settings.autostartScripts;
    Object.keys(autostartScripts)
      .filter((scriptName) => autostartScripts[scriptName] === "allow")
      .forEach((scriptName) => {
        const file = this.getScriptFileByName(scriptName);
        if (!file) {
          return;
        }
        void this.runAutostartScriptInView(
          scriptName,
          file,
          view,
          "ScriptEngine.runAutostartScripts",
        );
      });
  }

  unloadScript(basename: string, path: string) {
    if (!path.endsWith(".md")) {
      return;
    }
    delete this.scriptIconMap[path];
    this.scriptIconMap = { ...this.scriptIconMap };
    this.updateToolPannels();

    const providers = this.elementActionProviders.get(basename);
    if (providers) {
      providers.forEach((unregister) => unregister());
      this.elementActionProviders.delete(basename);
    }

    const commandId = `${PLUGIN_ID}:${basename}`;
    if (!this.app.commands.commands[commandId]) {
      return;
    }
    delete this.app.commands.commands[commandId];
  }

  async executeScript(
    view: ExcalidrawView = undefined,
    script: string,
    title: string,
    file: TFile,
    isLegacyYmjrAutorun = false,
  ) {
    if (!script || !title) {
      return;
    }
    //addresses the situation when after paste text element IDs are not updated to 8 characters
    //linked to onPaste save issue with the false parameter
    if (
      view &&
      view
        .getScene()
        .elements.some(
          (el) => !el.isDeleted && el.type === "text" && el.id.length > 8,
        )
    ) {
      await view.save(false, true);
    }

    script = stripYamlFrontmatter(script);
    try {
      script = prepareLegacyYmjrScript(script);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorlog({
        where: "ScriptEngine.executeScript",
        message: `${title}: ${message}`,
        error,
      });
      new Notice(`Excalidraw script compatibility error: ${message}`, 8000);
      return null;
    }
    this.rebindLegacyYmjrAutorunEAs(view);
    const ea = getEA(view);
    // Legacy autorun scripts extend the shared ExcalidrawAutomate instance
    // with an `ea.tools` object. Official getEA(view) deliberately creates a
    // fresh instance, so carry that local extension into the per-script EA
    // without copying or reimplementing the script-owned helper functions.
    const globalEA = this.plugin.ea as ExcalidrawAutomate & {
      tools?: LegacyYmjrEaTools;
    };
    const legacyTools = (globalEA.tools ??= {});
    // YMJR exposed this helper through ea.tools. The official plugin already
    // owns the implementation, so preserve the legacy API as a thin alias
    // instead of copying the algorithm into either the plugin or user script.
    legacyTools.wrapTextAtCharLength ??= wrapTextAtCharLength;
    Object.assign(ea, { tools: legacyTools });
    if (isLegacyYmjrAutorun) {
      // Autorun-installed callbacks and ea.tools helpers retain this EA in
      // their closures. Do not put it in the view-owned collection that is
      // destroyed when the first drawing unloads.
      this.legacyYmjrAutorunEAs.add(ea);
    } else {
      this.eaInstances.push(ea);
    }
    ea.activeScript = title;

    // Some YMJR autorun installers call window.ExcalidrawAutomate.getAPI()
    // while they are being evaluated, then close over that newly-created EA
    // instead of the `ea` argument above. Snapshot the plugin registry after
    // creating the installer EA so only nested instances created by the
    // autorun itself are adopted by the session-scoped compatibility layer.
    const pluginEAsBeforeAutorun = isLegacyYmjrAutorun
      ? this.snapshotPluginEAs()
      : null;

    //https://stackoverflow.com/questions/45381204/get-asyncfunction-constructor-in-typescript changed tsconfig to es2017
    //https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/AsyncFunction
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    let result = null;
    //try {
    try {
      result = await new AsyncFunction("ea", "utils", script)(ea, {
        inputPrompt: (
          header: string | InputPromptOptions,
          placeholder?: string,
          value?: string,
          buttons?: ButtonDefinition[],
          lines?: number,
          displayEditorButtons?: boolean,
          customComponents?: (container: HTMLElement) => void,
          blockPointerInputOutsideModal?: boolean,
          controlsOnTop?: boolean,
          draggable?: boolean,
        ) => {
          if (typeof header === "object") {
            const options = header;
            header = options.header;
            placeholder = options.placeholder;
            value = options.value;
            buttons = options.buttons;
            lines = options.lines;
            displayEditorButtons = options.displayEditorButtons;
            customComponents = options.customComponents;
            blockPointerInputOutsideModal =
              options.blockPointerInputOutsideModal;
            controlsOnTop = options.controlsOnTop;
            draggable = options.draggable;
          }
          return ScriptEngine.inputPrompt(
            view,
            this.plugin,
            this.app,
            header,
            placeholder,
            value,
            buttons,
            lines,
            displayEditorButtons,
            customComponents,
            blockPointerInputOutsideModal,
            controlsOnTop,
            draggable,
          );
        },
        suggester: (
          displayItems: string[],
          items: unknown[],
          hint?: string,
          instructions?: Instruction[],
        ) =>
          ScriptEngine.suggester(
            this.app,
            displayItems,
            items,
            hint,
            instructions,
          ),
        scriptFile: file,
      });
    } finally {
      if (pluginEAsBeforeAutorun) {
        this.captureLegacyYmjrAutorunEAs(pluginEAsBeforeAutorun, view);
      }
    }
    /*} catch (e) {
      new Notice(t("SCRIPT_EXECUTION_ERROR"), 4000);
      errorlog({ script: this.plugin.ea.activeScript, error: e });
  }*/
    return result;
  }

  /**
   * Retargets the EA instances captured by legacy autorun closures.
   *
   * YMJR kept these helpers session-scoped. The official runner normally
   * creates disposable per-script EA instances, so retaining and rebinding
   * only the autorun instances restores that lifecycle without changing the
   * original encrypted scripts or their Action IDs.
   */
  private rebindLegacyYmjrAutorunEAs(view?: ExcalidrawView): void {
    if (!view) {
      return;
    }
    // Some original YMJR helpers close over the global EA rather than the
    // per-autorun argument. Official Excalidraw Automate keeps that object
    // viewless by default, so bind it to the same live drawing as retained
    // autorun instances without changing the original script implementation.
    if (this.plugin.ea) {
      this.plugin.ea.targetView = view;
    }
    this.legacyYmjrAutorunEAs.forEach((ea) => {
      ea.targetView = view;
    });
  }

  /** Returns the currently-live EAs registered through the public API. */
  private snapshotPluginEAs(): Set<ExcalidrawAutomate> {
    const snapshot = new Set<ExcalidrawAutomate>();
    this.plugin.eaInstances.forEach((ea) => snapshot.add(ea));
    return snapshot;
  }

  /**
   * Adopts EAs created inside a legacy autorun script. Helpers installed by
   * HyperFlux capture these nested instances in closures, so they need the
   * same session lifetime and active-view rebinding as the installer EA.
   */
  private captureLegacyYmjrAutorunEAs(
    existingEAs: Set<ExcalidrawAutomate>,
    view?: ExcalidrawView,
  ): void {
    this.plugin.eaInstances.forEach((ea) => {
      if (existingEAs.has(ea)) {
        return;
      }
      ea.targetView = view ?? null;
      this.legacyYmjrAutorunEAs.add(ea);
    });
  }

  private updateToolPannels() {
    const excalidrawViews = getExcalidrawViews(this.app, true);
    excalidrawViews.forEach((excalidrawView) => {
      excalidrawView.toolsPanelRef?.current?.updateScriptIconMap(
        this.scriptIconMap,
      );
    });
  }

  public static async inputPrompt(
    view: ExcalidrawView,
    plugin: ExcalidrawPlugin,
    app: App,
    header: string,
    placeholder?: string,
    value?: string,
    buttons?: ButtonDefinition[],
    lines?: number,
    displayEditorButtons?: boolean,
    customComponents?: (container: HTMLElement) => void,
    blockPointerInputOutsideModal?: boolean,
    controlsOnTop?: boolean,
    draggable: boolean = false,
  ) {
    try {
      return await GenericInputPrompt.Prompt(
        view,
        plugin,
        app,
        header,
        placeholder,
        value,
        buttons,
        lines,
        displayEditorButtons,
        customComponents,
        blockPointerInputOutsideModal,
        controlsOnTop,
        draggable,
      );
    } catch {
      return undefined;
    }
  }

  public static async suggester<T>(
    app: App,
    displayItems: string[],
    items: T[],
    hint?: string,
    instructions?: Instruction[],
  ): Promise<T | undefined> {
    try {
      return await GenericSuggester.Suggest(
        app,
        displayItems,
        items,
        hint,
        instructions,
      );
    } catch (error: unknown) {
      errorlog({
        message: "unexpected error in suggester",
        where: "ScriptEngine.suggester",
        error,
      });
      return undefined;
    }
  }
}
