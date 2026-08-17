/**
 * Backwards-compatible adapters for Excalidraw imperative APIs exposed to
 * vault scripts. Keep these adapters at the plugin boundary so the embedded
 * Excalidraw package can continue following its current public API.
 */

import type { ExcalidrawImperativeAPI } from "@zsviczian/excalidraw/types/excalidraw/types";
import type { ExcalidrawElement } from "@zsviczian/excalidraw/types/element/src/types";
import { getCommonBoundingBox } from "src/constants/constants";

type LegacyScrollToContentOptions = {
  fitToContent?: boolean;
  fitToViewport?: boolean;
  viewportZoomFactor?: number;
  animate?: boolean;
  duration?: number;
};

type LegacyScrollToContent = (
  target?: ExcalidrawElement | readonly ExcalidrawElement[] | null,
  options?: LegacyScrollToContentOptions,
) => void;

type ExcalidrawImperativeAPIWithLegacyViewport = ExcalidrawImperativeAPI & {
  scrollToContent?: LegacyScrollToContent;
};

const getLegacyAnimation = (options: LegacyScrollToContentOptions) => {
  if (!options.animate) {
    return false;
  }

  return typeof options.duration === "number" && options.duration >= 0
    ? { duration: options.duration }
    : true;
};

/**
 * Restores the pre-2.26 `scrollToContent()` scripting surface by translating
 * legacy calls to the current `setViewport()` API.
 *
 * The adapter is idempotent and only adds the method when the embedded
 * Excalidraw runtime does not already provide it. This lets updated scripts
 * use `setViewport()` while older vault and Action scripts keep working.
 *
 * @param api - The window-scoped Excalidraw imperative API for a view.
 * @returns The same API instance, decorated when compatibility was needed.
 */
export const installLegacyScrollToContentCompatibility = (
  api: ExcalidrawImperativeAPI,
): ExcalidrawImperativeAPI => {
  const compatibleAPI = api as ExcalidrawImperativeAPIWithLegacyViewport;
  if (typeof compatibleAPI.scrollToContent === "function") {
    return api;
  }

  compatibleAPI.scrollToContent = (target, options = {}) => {
    const candidateElements = target
      ? Array.isArray(target)
        ? target
        : [target]
      : api.getSceneElements();
    // `setViewport()` performs the current runtime's deleted/missing-element
    // filtering. Keeping that responsibility there also preserves its warning
    // and target-resolution behavior.
    const elements = candidateElements;

    if (elements.length === 0) {
      return;
    }

    const animation = getLegacyAnimation(options);
    const targetZoom = options.viewportZoomFactor;
    const appState = api.getAppState();

    if (
      typeof targetZoom === "number" &&
      Number.isFinite(targetZoom) &&
      targetZoom > 0 &&
      appState.width > 0 &&
      appState.height > 0
    ) {
      const bounds = getCommonBoundingBox(elements);
      const viewportWidth = appState.width / targetZoom;
      const viewportHeight = appState.height / targetZoom;
      const centerX = (bounds.minX + bounds.maxX) / 2;
      const centerY = (bounds.minY + bounds.maxY) / 2;

      api.setViewport({
        target: {
          x: centerX - viewportWidth / 2,
          y: centerY - viewportHeight / 2,
          width: viewportWidth,
          height: viewportHeight,
        },
        fit: "contain",
        animation,
      });
      return;
    }

    api.setViewport({
      target: elements,
      fit:
        options.fitToContent === false
          ? "none"
          : options.fitToViewport
            ? "contain"
            : "scale-down",
      animation,
    });
  };

  return api;
};
