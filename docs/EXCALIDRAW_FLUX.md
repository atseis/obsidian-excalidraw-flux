# Excalidraw Flux

## Goal

Excalidraw Flux is an open-source extension of the official Excalidraw and Obsidian Excalidraw projects. It is designed to keep accepting upstream releases while preserving documented legacy scene formats and the user's HyperFlux workflows. YMJR remains the historical compatibility reference, not the product name.

The compatibility boundary is deliberately one-way:

```text
open-source Excalidraw core + Obsidian plugin
  -> original HyperFlux Excalidraw scripts
    -> original Actions / Action Platform / Alt+S
```

Only the bottom layer is reconstructed here. HyperFlux scripts and Action definitions remain user-owned data and should be copied without rewrites. When an original script fails because it expects a YMJR-only loader, lifecycle or API, the default fix is a narrow compatibility adapter in the open-source plugin/core rather than a replacement script or a changed Action ID.

The reconstruction does not use the closed YMJR `main.js`, `manifest.json`, or `styles.css` as source. Read-only YMJR drawings and SVG exports are treated as behavioral/serialization references and regression fixtures.

The two upstream repositories retain their own licenses: the Excalidraw core is MIT-licensed, while the Obsidian Excalidraw plugin repository ships an AGPL-3.0 `LICENSE`. Any published fork must preserve the applicable copyright and license notices; do not describe the combined plugin distribution as MIT-only based solely on `package.json` metadata.

## Repository boundary

```text
zsviczian-excalidraw-ymjr-rebuild
  Local Excalidraw Flux Core working tree
  Flux geometry, binding, rendering, UI and legacy serialization compatibility

obsidian-excalidraw-plugin-ymjr-rebuild
  Local Excalidraw Flux plugin working tree
  Excalidraw Automate, settings, scripts, templates and deployment

/home/wy/文档/obsidian-test
  The only deployment and manual-test vault

HyperFlux
  Read-only compatibility reference and source for copied test data
```

## Implemented compatibility surface

### Excalidraw core

- Arrowheads: `chevron`, `chevron_outline`, `block_arrow`, `block_arrow_outline`.
- Arrow paths: Sharp, Round, Elbow and automatic Curve.
- Connection modes: None, Points and Edge.
- YMJR-compatible serialized fields: `customData.curveArrow` and `customData.snap`.
- Points-mode start preview and first-pointer-down snapping.
- Full closed Block arrow geometry for Sharp, Round, Elbow and automatic Curve paths, shared by rendering, bounds and collision handling.
- Automatic Curve arrowheads use the canonical cubic endpoint tangents at both ends, including ordinary markers paired with a Block arrow endpoint.
- Legacy `customData.svgPathShape` lines render, hit-test and compute bounds from the stored SVG path, restoring the smooth four-direction brace Actions.
- Legacy `customData.animation` lines support the original `add animation for line` script's dash and moving-arrow modes, including curved and automatic-curve paths.
- Host-configurable digit/letter aliases for tools 0–8, with the HyperFlux defaults (digits for 0–7 and `T` for Text).
- Host property shortcuts: `s` opens Stroke color, `g` opens Background color, and `ls`/`ld`/`lt` select ordinary solid/dashed/dotted strokes. Those three explicit style choices remove only `customData.animation` from selected lines/arrows while preserving all other custom data. `la` then applies the matching default animation directly to selected dashed/dotted lines: `[8, 8]` for dashed or `[1.5, 6]` for dotted, both at speed `2`, with no parameter dialog. The original `add animation for line` Action remains unchanged for custom parameters and removal.
- Arrowhead shortcuts: `a` opens a two-stroke selector whose second key matches the native Arrowhead picker. A lowercase second key changes the end Arrowhead; Shift+the second key changes the start. The complete mapped set is `q` None, `w` Arrow, `e` Triangle, `r` Triangle outline, `t` Chevron, `y` Chevron outline, `b` Block arrow, `n` Block arrow outline, `a` Circle, `s` Circle outline, `d` Diamond, `f` Diamond outline, `z` Bar, `x` Cardinality one, `c` Cardinality many and `v` Cardinality one-or-many. Arrow paths remain independently selectable from the native properties panel.
- The Stroke and Background palettes add Navy (`n`), Lime (`l`), Mint (`m`), Olive (`o`) and Plum (`p`); every family retains the existing `Shift+1`…`Shift+5` shade selection.
- Canvas shortcut guards cover Excalidraw text editing, input/textarea/contenteditable targets and IME composition (`isComposing`, `Process`, key code 229), without consuming `Alt+S`, Ctrl/Cmd shortcuts or Shift eyedroppers.
- Focused geometry tests plus a real canvas pointer interaction test.

The main compatibility implementation is ring-fenced in `packages/element/src/ymjrArrowFeatures.ts`; small integration points in upstream-owned files carry the `zsviczian` fingerprint required by the core fork.

Complex Block arrows use the verified YMJR dimensions (16 px shaft, 40 px head width and 32 px head length). Orthogonal routes use exact mitered offset joins matching the read-only YMJR SVG fixture. Round and automatic routes sample their canonical cubic centerline before constructing the same closed silhouette; solid and outline styles therefore share one boundary without a shaft/head seam.

### Obsidian plugin script runtime

- Legacy local script envelope: scripts beginning with `//ymjr` are decoded as AES-128-CBC, Base64 and zero padding with the legacy `ymjrymjrymjr0001` key/IV. Plaintext scripts continue through the unchanged official runner.
- Local-only execution: decoding never downloads or evaluates remote code. Invalid Base64, bad ciphertext and decoding failures produce an explicit Notice and isolated error.
- Legacy autorun lifecycle: scripts with `autorun: true` frontmatter or a basename beginning with `autorun`/`_autorun` run once per plugin session, behind the existing `enableOnloadScripts` permission. `node_modules` and `temp_encrypt` are excluded.
- Dynamic EA bridge: helpers installed by an autorun script on the shared `window.ExcalidrawAutomate.tools` object are exposed by reference on every fresh `getEA(view)` script instance.
- Autorun EA lifetime bridge: installer EAs and EAs created while an autorun is executing are retained for the plugin session and rebound to the current live drawing. The shared `window.ExcalidrawAutomate` object is rebound as well because original helpers such as `updateSceneByZoom` close over that global object directly. Closing a drawing retargets these helpers to another live Excalidraw view when available.
- `ea.tools.wrapTextAtCharLength`: the legacy entry point is preserved as a thin alias to the official `src/utils/textUtils.ts` implementation. The algorithm is not duplicated.
- The HyperFlux `_autorun-utils.md` script currently installs 23 original helpers. Together with the plugin-owned `wrapTextAtCharLength` alias, a cold start exposes 24 `ea.tools` entries.

This separation is important: helper implementations such as `getConnectionDir` and `getElbowPointsAndPathByElement` still belong to the original `_autorun-utils.md` script. The plugin only restores when that script runs and how its shared tool object reaches a per-Action EA instance.

### Native WebP auto-export

- The normal Export Settings UI includes `WebP export quality`, defaulting to `0.80`, and the Auto-export Settings section includes an independent `Auto-export WebP` toggle alongside SVG and PNG. The quality value is the browser WebP encoder's quantitative quality factor, not a claim that perceptual sharpness is exactly 80% of SVG.
- A normal drawing save can generate `drawing.webp`, or `drawing.dark.webp` and `drawing.light.webp` when dual-theme export is enabled. The implementation uses Excalidraw's local canvas export pipeline, supports transparent backgrounds, theme, padding and image scale, and does not call a network conversion service.
- The encoder result must report MIME type `image/webp`; a browser fallback PNG is rejected instead of being written with a false `.webp` extension.
- `Keep the .SVG, .PNG, and/or .WebP filenames in sync with the drawing file` covers WebP rename, deletion and Markdown conversion paths through the shared export-type registry.
- Per-file `excalidraw-autoexport: webp` overrides the global switch for a WebP-only file. `all` enables SVG, PNG and WebP; the historical `both` value remains SVG + PNG for backward compatibility.
- The auto-export hook contract has an optional `webp` field. Hook results are merged into the current export configuration, so an unchanged legacy hook cannot accidentally erase a newly added format; a hook may still explicitly return `webp: false`.
- PNG and WebP share the established raster image-scale setting. Existing PNG configuration and frontmatter remain compatible.
- Hot-reload lifecycle guards stop queued autosave and `setViewData()` callbacks from dereferencing a retired plugin/settings object. This is particularly important for the local compile → plugin reload → save development loop.

The read-only HyperFlux storage audit found 439 same-name Excalidraw SVG exports using 550,277,539 bytes (about 524.79 MiB), with a median around 459 KiB and a largest file around 26.72 MiB. Quality-80 conversions written only under `/tmp` measured the following representative reductions:

| SVG source | SVG bytes | WebP bytes | Reduction |
| --- | ---: | ---: | ---: |
| `粗粒度信号造成“时间不对称性”…` | 470,778 | 24,624 | 94.8% |
| `@agrawalSARATHIEfficientLLM2023` | 1,726,160 | 318,068 | 81.6% |
| `Congestion Management Sublayer` | 8,217,234 | 140,980 | 98.3% |
| `LLM 推理网络` | 28,016,489 | 474,256 | 98.3% |

These samples support WebP for gallery/waterfall previews, but they are not a promise of one vault-wide ratio. Very simple vector drawings can be smaller as SVG; for example, the runtime fixture's 45,846-byte SVG is smaller than its full-size 110,906-byte quality-80 WebP.

## GitHub and BRAT distribution

The existing `obsidian-excalidraw-plugin-ymjr-rebuild` working tree is the distributable Obsidian plugin repository; a third source copy is unnecessary. Its public GitHub repository is `atseis/obsidian-excalidraw-flux`, and the modified Core is published separately at `atseis/excalidraw-flux-core`. Repository names and Git remotes do not determine Obsidian's runtime plugin identity.

Keep `manifest.json` and `manifest-beta.json` at the official runtime ID:

```json
{
  "id": "obsidian-excalidraw-plugin"
}
```

This deliberately makes Excalidraw Flux a replacement distribution of Excalidraw instead of a side-by-side plugin. ExcaliBrain looks up `app.plugins.plugins["obsidian-excalidraw-plugin"]`, then validates the Excalidraw Automate instance returned by `getEA()`. Retaining the ID therefore preserves ExcaliBrain compatibility without requiring every user to install a patched ExcaliBrain. It also preserves the existing plugin directory, settings, commands and script expectations. The official and Flux builds are alternatives and must not be enabled simultaneously.

The version pattern `2.27.0-flux.YYYYMMDD.N` is valid Semantic Versioning and gives every local or BRAT build a unique, ordered prerelease version. The numeric prefix records the synchronized official plugin baseline; the manifest description and this document record Core `0.18.125`. Public Git tags and both manifests must use the same version. The personal fork is the only push target; the original `zsviczian` repository remains a fetch-only upstream.

The existing `.github/workflows/release.yml` builds tagged commits and attaches `main.js`, `styles.css` and `manifest.json` to a stable GitHub Release, which is the artifact contract BRAT expects. Flux version tags contain a hyphen but are intentionally marked stable at the GitHub Release level; only explicit alpha, beta and release-candidate tags are marked prerelease. The workflow checks out an exact public `excalidraw-flux-core` commit, builds its four Obsidian consumer artifacts from source and embeds them into the plugin, avoiding generated Core binaries in the plugin's Git history. BRAT users then add the public plugin repository URL. Because the manifest ID is the official one, BRAT updates replace the installed Excalidraw code while leaving vault-local `data.json` intact.

## Verified compatibility baseline

The current deployed test build is `2.27.0-flux.20260817.5` in `/home/wy/文档/obsidian-test`; HyperFlux remains read-only.

- Core regression suite: 6 focused files, 182/182 tests passed, including Block arrow geometry across every path, Automatic Curve endpoint-marker direction, all 16 end-Arrowhead and 16 start-Arrowhead shortcut mappings, next-arrow defaults, Points-mode start snapping, legacy animation/brace formats, font compatibility, configurable 0–8 tool aliases, the host selectors, the expanded color palette and all keyboard-input guards. The `ls`/`ld`/`lt` cases also start with an animated line and prove that the animation field is removed without deleting unrelated custom data.
- Core type checking, Core `build:obsidian`, local Core packing and the plugin production build completed successfully. The deployed `main.js`, built `dist/main.js`, runtime plugin report and both source manifests all identify `2.27.0-flux.20260817.5`. The deployed and built artifacts match exactly: `main.js` SHA-256 `32a5d97b1b546279973b63e04d8da8e58815e9ba350b4eddb4f32c654969aabc`, `styles.css` `40fab07c21a6d753728b9032fe0dc552e97404a6e4ac550202fdc70bbf6f9cde`, and `manifest.json` `7dd9589d81cbe75a7d8a900778a97e35b7dd49c8c0bdf5a57e90517267c2ed13`. The deployed `main.js` is 4,817,712 bytes.
- WebP runtime checks passed with global SVG/PNG disabled and WebP enabled at quality `0.80`: a normal dirty save produced a genuine `RIFF … WEBP` file at 2300×1244, MIME detection rejected format spoofing, no PNG was generated and an existing SVG timestamp did not change. The same fixture shrank from 136,606 bytes at quality 0.85 to 110,906 bytes at quality 0.80.
- Settings DOM verification found `PNG/WebP export image scale`, `WebP export quality`, the SVG/PNG/WebP synchronization text, and all three auto-export toggles. A dedicated `img-view:: [[WebP Autoexport Fixture.excalidraw.webp]]` link resolves through Obsidian metadata.
- The WebP-only frontmatter override worked while the global WebP toggle was temporarily false. Rename synchronization moved the generated WebP with the drawing and restored both to their original names. A simulated legacy auto-export hook that omitted `webp` still preserved the enabled WebP export, and the hook was restored after the probe.
- After a full application restart, normal save and a subsequent same-version plugin hot reload/save both updated the WebP and left the Obsidian error buffer empty, validating the retired-view lifecycle guards.
- Cold vault reload exposes all 23 autorun helpers plus `wrapTextAtCharLength`; the Obsidian error buffer is empty.
- The unchanged `add animation for line` Action was exercised through both its command and its earlier `da` route. Its remove-animation branch deletes `customData.animation`, calls the original `ea.tools.updateSceneByZoom`, and leaves the Obsidian error buffer empty. It remains registered under its original command ID for advanced parameters even though the fast path has moved to `la`.
- Real keyboard-event checks pass for the configured 0–8 aliases, `s`, `g`, `ls`, `ld`, `lt`, `la`, every Arrowhead second key from `aq` through `av`, their Shift-modified start equivalents, input/textarea/contenteditable protection, IME composition protection (`isComposing`, `Process`, key code 229), color-picker event isolation and Ctrl/Cmd non-interception by the host shortcut layer. Plain `d` no longer opens the line-style selector. The persisted defaults are digits enabled and letters disabled for tools 0–7, with digit disabled and `T` enabled for Text.
- Real runtime state checks prove `ld → la` writes `{type: "arrow", style: "dash", strokeLineDash: [8, 8], speed: 2}` and `lt → la` writes the corresponding `[1.5, 6]` dotted contract. Neither path opens a dialog; `la` on solid is a no-op. Static-canvas two-frame probes observed 332 changed pixels for dashed animation and 327 for dotted animation. Following either animation with `lt` or `ls` removes the animation immediately and produces an ordinary stroke.
- The Arrowhead selector changes selected arrows and the next-arrow start/end defaults without changing Sharp, Round, Elbow or Automatic Curve path data. A real Automatic Curve probe applied `ab` to the end and `a` + Shift+`N` to the start, producing `endArrowhead: "block_arrow"` and `startArrowhead: "block_arrow_outline"` while preserving `customData.curveArrow`, its animation metadata, `roundness` and `elbowed`; the scene snapshot was then restored byte-for-byte at those fields.
- Stroke and Background color pickers select all five added families with their documented keys: Navy `n`, Lime `l`, Mint `m`, Olive `o` and Plum `p`. A real `Shift+1` shade change selected `#edf2ff`; picker-local `l` and `a` events did not leak into the Line or Arrow selectors.
- Four brace elements produced through the original direction Actions retain smooth `customData.svgPathShape` paths containing quadratic curves and are rendered by the core path implementation.
- All 17 encrypted Actions identified during the YMJR audit have been executed in a real Obsidian runtime. Representative results include bound-arrow right-angle conversion, endpoint normalization, arrowhead changes, text wrapping, layout, geometry generation and grid tools.
- `wrap text.md` was rerun after a clean reload with no temporary runtime injection. `YMJR font size regression` wrapped at 8 characters to four lines.
- Action registry audit: 88 base Actions + 4 Recipes; zero JSON parse failures, duplicate IDs, schema failures, missing script files, missing Recipe dependencies, invalid Favorites or invalid Recent IDs.
- All 69 script-backed Action files are byte-for-byte identical to their HyperFlux originals. Their IDs and `scriptPath` values were not changed.
- Obsidian still reports the custom `Alt+S` binding for the original Action Platform command. Executing that exact registered command in the `.5` runtime opens the original panel and reports `88 base actions · 4 recipes`; it was closed again after the probe. The original `横向平面` Recipe previously produced a real geometry update without a runtime error.
- A cold application reload confirms the loaded manifest is `Excalidraw Flux` by `atseis`, the plugin and its global Excalidraw Automate instance match, ExcaliBrain reports `pluginLoaded: true`, `ExcaliBrain.EA.plugin` is the same Flux instance, and the Obsidian error buffer is empty.
- The copied resources contain the same 546 `plugins/Excalidraw` files, 26 `configs/plugins/Excalidraw` files and 4 font files as HyperFlux. The only resource-tree difference is `plugins/Excalidraw/Actions/state/ui.json`, whose recent order, last Action, transient parameters and timestamp are expected to change during testing. Templates, fonts, scripts and Action definitions otherwise match their HyperFlux sources.
- HyperFlux's complete 5.6 MB Excalidraw `data.json` was copied into the test vault, including the 94-item embedded Library and all Action/script parameters. The current plugin kept `libraryStorageMode: "data-json"` after the migration prompt. Across all 195 keys originating in HyperFlux, the only differences after normalization are the intentional `autoexportSVG: false` WebP test policy and the Library source label updated to the current Flux version; fonts, default styling, autosave intervals, template/script paths and all other legacy values match. New WebP/default keys are additive.
- A cold drawing open executes all 43 legacy autorun scripts and exposes 24 EA tools. The exact configured Action Platform command exists, Obsidian reports `Alt + S (custom)`, and executing it opens `88 base actions · 4 recipes`; the panel closes without errors.

## Known gaps

- HyperFlux contains 43 autorun scripts in total. The reconstructed lifecycle loads them, and the current runtime shows their installed helper/hook globals, but the approximately 35 hook-oriented callbacks have not yet received one-by-one event-trigger regression tests. Autorun installation must not be confused with proof that every official-core event invokes every legacy hook at the correct phase.
- The active HyperFlux script tree contains 310 Markdown scripts, including 163 `//ymjr` envelopes. All 163 decode successfully, but only the Action set and selected representative non-Action paths have been dynamically exercised.
- Popout-window, mobile, all library interactions, and every copied non-Action script have not yet been dynamically tested.
- Any additional legacy fields or callback contracts discovered by those tests must be reconstructed from a minimal drawing/interaction fixture. Do not infer a broad private contract from a single obfuscated script.

Consequently, the Action workflow is verified against the current baseline, but the project must not yet claim blanket compatibility for every one of the 310 scripts or every YMJR hook-driven feature.

Private core hooks should be implemented through one typed, versioned dispatcher with explicit arguments, return semantics, execution phase and error isolation. Do not scatter arbitrary `window.*Hook` calls across upstream files.

## Local build and deployment

Every runtime change must receive a new unique local plugin version. From the plugin repository:

```bash
node scripts/build-and-deploy-flux-local.mjs \
  --version 2.27.0-flux.YYYYMMDD.N
```

The command:

1. runs the focused geometry and real-pointer regression tests;
2. builds the four Excalidraw Obsidian consumer artifacts;
3. restores the lockfile-pinned official Core package as a bootstrap dependency;
4. copies and SHA-256-verifies the four freshly built local Flux Core artifacts in the plugin's installed dependency;
5. builds the plugin with the requested version embedded in `main.js`;
6. copies only `main.js`, `styles.css` and `manifest.json` into `/home/wy/文档/obsidian-test`;
7. confirms that `data.json` was preserved;
8. reloads the plugin and reports Obsidian's actually loaded version.

The script has a fixed vault allow-list and refuses any HyperFlux deployment. `test:typecheck` remains a separate quality gate and currently passes. The focused tests and production `build:obsidian` must also pass before deployment.

## Upstream update procedure

Keep upstream synchronization and legacy-compatibility feature work as separate checkpoints:

1. Fetch and inspect the official core/plugin changes without modifying the test vault.
2. Merge or rebase the official core fork and resolve only the narrow Flux/legacy-compatibility integration points.
3. Run focused tests, `build:obsidian`, and `test:typecheck`; record unrelated upstream baseline diagnostics separately.
4. Update the plugin shell from its official upstream independently.
5. Build and deploy a new unique local version through `build-and-deploy-flux-local.mjs`.
6. Manually verify old YMJR drawings, new arrow creation, HyperFlux templates, Library, fonts, representative EA scripts, ExcaliBrain, main window and popout window behavior.

Never use the closed YMJR bundle as the maintained implementation. Any newly discovered behavior must first be described as a format/interaction fixture, then implemented in source with a regression test.
