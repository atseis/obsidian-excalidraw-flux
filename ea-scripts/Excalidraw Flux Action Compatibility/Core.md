/*
 * Excalidraw Flux Action Compatibility
 *
 * A clean-room, readable compatibility layer for the legacy YMJR Excalidraw
 * scripts used by HyperFlux. It deliberately uses Excalidraw Automate's public
 * API only. The small wrapper scripts pass `actionId` into this file.
 *
 * Compatibility promises:
 * - legacy Action Platform IDs and script command paths stay stable;
 * - table customData keeps the historical root/row/column contract;
 * - grouped selections and bound text move as one layout unit;
 * - arrow bindings, snap metadata and YMJR curve metadata are retained unless
 *   the selected operation explicitly changes the route type;
 * - block_arrow and block_arrow_outline remain valid on every curve style.
 *
 * Version: 1.0.0-open
 */

"use strict";

const OPEN_ACTION_VERSION = "1.0.0-open";
const ACTION_REQUEST_KEY = "__eaActionPlatformScriptRequest__";
const requestCandidate = window?.[ACTION_REQUEST_KEY];
const actionRequest =
  requestCandidate &&
  requestCandidate.source === "Action Platform" &&
  requestCandidate.actionId === actionId
    ? requestCandidate
    : null;

const ACTION_LABELS = {
  "script.generate.cuboid": "Cuboid / 生成立方体",
  "script.generate.table": "Table / 生成表格",
  "script.geometry.generate-polygon": "Polygon / 生成多边形",
  "script.geometry.hex-shape-grid": "Hex Shape Grid / 六边形网格",
  "script.geometry.shape-grid": "Shape Grid / 形状网格",
  "script.layout.grid-selected": "Grid Selected / 选中对象网格化",
  "script.layout.horizontal-align": "Horizontal Align / 水平对齐",
  "script.layout.horizontal-distribute": "Horizontal Distribute / 水平分布",
  "script.layout.vertical-align": "Vertical Align / 垂直对齐",
  "script.layout.vertical-distribute": "Vertical Distribute / 垂直分布",
  "script.line.normalize-arrow-endpoints": "Normalize Arrow Endpoints / 规范箭头端点",
  "script.line.to-right-angle": "Line to Right Angle / 线条转直角",
  "script.line.to-right-angle-multipoints": "Line to Right Angle Multi / 多点直角线",
  "script.style.set-angle": "Set Angle / 设置角度",
  "script.style.set-arrow-type": "Set Arrow Type / 设置箭头类型",
  "script.style.set-font-size": "Set Font Size / 设置字号",
  "script.text.wrap": "Wrap Text / 文本换行",
};

const deepClone = (value) => JSON.parse(JSON.stringify(value));
const uniqueById = (elements) => {
  const seen = new Set();
  return (elements || []).filter((element) => {
    if (!element || element.isDeleted || seen.has(element.id)) return false;
    seen.add(element.id);
    return true;
  });
};
const liveSceneElements = () =>
  (ea.getViewElements?.() || []).filter((element) => !element.isDeleted);
const selectedElements = () =>
  (ea.getViewSelectedElements?.() || []).filter((element) => !element.isDeleted);
const toFiniteNumber = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const clampNumber = (value, min, max) =>
  Math.min(max, Math.max(min, value));
const positiveInteger = (value, fallback, max = 200) =>
  clampNumber(Math.round(toFiniteNumber(value, fallback)), 1, max);
const positiveNumber = (value, fallback, max = 100000) =>
  clampNumber(toFiniteNumber(value, fallback), 0.01, max);
const boolValue = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  return !(
    value === false ||
    value === 0 ||
    value === "0" ||
    String(value).toLowerCase() === "false"
  );
};
const actionParams = () => actionRequest?.params || {};
const hasActionParam = (name) =>
  Object.prototype.hasOwnProperty.call(actionParams(), name);
const param = (name, fallback) =>
  hasActionParam(name) ? actionParams()[name] : fallback;

async function promptJson(title, defaults) {
  const initial = JSON.stringify(defaults, null, 2);
  const answer = await utils.inputPrompt(title, initial, initial, null, 8);
  if (!answer) return null;
  try {
    const parsed = JSON.parse(answer);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("The input must be a JSON object.");
    }
    return { ...defaults, ...parsed };
  } catch (error) {
    throw new Error(`Invalid JSON input: ${error.message || error}`);
  }
}

async function configFromParamsOrPrompt(title, defaults) {
  if (actionRequest) return { ...defaults, ...actionParams() };
  return promptJson(title, defaults);
}

function sceneCenterOrigin(width, height) {
  const center = ea.getViewCenterPosition?.() || { x: 0, y: 0 };
  return { x: center.x - width / 2, y: center.y - height / 2 };
}

async function commitCreated(ids, group = true) {
  if (!ids.length) return false;
  if (group && ids.length > 1) ea.addToGroup(ids);
  await ea.addElementsToView(false, true, false);
  ea.selectElementsInView?.(ids);
  return true;
}

function sceneMap() {
  return new Map(liveSceneElements().map((element) => [element.id, element]));
}

function addBoundText(elements, elementsById = sceneMap()) {
  const expanded = [...elements];
  for (const element of elements) {
    for (const binding of element.boundElements || []) {
      if (binding?.type !== "text") continue;
      const text = elementsById.get(binding.id);
      if (text) expanded.push(text);
    }
    if (element.type === "text" && element.containerId) {
      const container = elementsById.get(element.containerId);
      if (container) expanded.push(container);
    }
  }
  return uniqueById(expanded);
}

function layoutUnits() {
  const selected = selectedElements();
  if (!selected.length) throw new Error("Select one or more elements first.");
  const elementsById = sceneMap();
  const groups = ea.getMaximumGroups?.(selected) || selected.map((el) => [el]);
  return groups.map((group) => addBoundText(group, elementsById));
}

async function applyUnitTranslations(units, translations, selectionIds) {
  const elementsToEdit = uniqueById(units.flat());
  ea.clear();
  ea.copyViewElementsToEAforEditing(elementsToEdit);
  units.forEach((unit, index) => {
    const translation = translations[index] || { x: 0, y: 0 };
    for (const source of unit) {
      const clone = ea.getElement(source.id);
      if (!clone) continue;
      clone.x += translation.x || 0;
      clone.y += translation.y || 0;
    }
  });
  await ea.addElementsToView(false, true, false);
  ea.selectElementsInView?.(selectionIds);
}

async function mutateSelected(elements, mutation, selectionIds) {
  const unique = uniqueById(elements);
  if (!unique.length) throw new Error("No compatible selected elements.");
  ea.clear();
  ea.copyViewElementsToEAforEditing(unique);
  for (const source of unique) {
    const clone = ea.getElement(source.id);
    if (clone) await mutation(clone, source);
  }
  await ea.addElementsToView(false, true, false);
  ea.selectElementsInView?.(selectionIds || unique.map((element) => element.id));
  return true;
}

function polygonPoints(centerX, centerY, radius, sides, rotationDegrees = -90) {
  const rotation = (rotationDegrees * Math.PI) / 180;
  const points = [];
  for (let index = 0; index < sides; index++) {
    const angle = rotation + (index * Math.PI * 2) / sides;
    points.push([
      centerX + Math.cos(angle) * radius,
      centerY + Math.sin(angle) * radius,
    ]);
  }
  points.push([...points[0]]);
  return points;
}

async function generateCuboid() {
  const defaults = {
    width: 180,
    height: 120,
    depth: 80,
    angle: 45,
    hiddenEdges: false,
  };
  const config = await configFromParamsOrPrompt("Generate cuboid / 生成立方体", defaults);
  if (!config) return false;
  const width = positiveNumber(config.width, defaults.width);
  const height = positiveNumber(config.height, defaults.height);
  const depth = positiveNumber(config.depth, defaults.depth);
  const angle = (toFiniteNumber(config.angle, defaults.angle) * Math.PI) / 180;
  const dx = Math.sin(angle) * depth;
  const dy = Math.cos(angle) * depth;
  const boundsWidth = width + Math.abs(dx);
  const boundsHeight = height + Math.abs(dy);
  const origin = sceneCenterOrigin(boundsWidth, boundsHeight);
  const x = origin.x + Math.max(0, -dx);
  const y = origin.y + Math.max(0, dy);
  const ids = [];

  ids.push(ea.addRect(x, y, width, height));
  ids.push(
    ea.addLine([
      [x, y],
      [x + width, y],
      [x + width + dx, y - dy],
      [x + dx, y - dy],
      [x, y],
    ]),
  );
  ids.push(
    ea.addLine([
      [x + width, y],
      [x + width, y + height],
      [x + width + dx, y + height - dy],
      [x + width + dx, y - dy],
      [x + width, y],
    ]),
  );

  if (boolValue(config.hiddenEdges, defaults.hiddenEdges)) {
    const previousStrokeStyle = ea.style.strokeStyle;
    ea.style.strokeStyle = "dotted";
    ids.push(ea.addLine([[x + dx, y - dy], [x + dx, y + height - dy]]));
    ids.push(
      ea.addLine([
        [x + dx, y + height - dy],
        [x + width + dx, y + height - dy],
      ]),
    );
    ids.push(ea.addLine([[x + dx, y + height - dy], [x, y + height]]));
    ea.style.strokeStyle = previousStrokeStyle;
  }
  return commitCreated(ids);
}

async function generateTable() {
  const defaults = { rows: 4, columns: 3, cellWidth: 100, cellHeight: 60 };
  const config = await configFromParamsOrPrompt("Generate table / 生成表格", defaults);
  if (!config) return false;
  const rows = positiveInteger(config.rows, defaults.rows, 100);
  const columns = positiveInteger(config.columns, defaults.columns, 100);
  const cellWidth = positiveNumber(config.cellWidth, defaults.cellWidth);
  const cellHeight = positiveNumber(config.cellHeight, defaults.cellHeight);
  const origin = sceneCenterOrigin(columns * cellWidth, rows * cellHeight);
  const ids = [];
  let rootId = null;

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const id = ea.addRect(
        origin.x + column * cellWidth,
        origin.y + row * cellHeight,
        cellWidth,
        cellHeight,
      );
      rootId ||= id;
      const element = ea.getElement(id);
      element.customData = {
        ...(element.customData || {}),
        table: { root: rootId, row, col: column, rowNum: rows, colNum: columns },
        openActionVersion: OPEN_ACTION_VERSION,
      };
      ids.push(id);
    }
  }
  return commitCreated(ids);
}

async function generatePolygon() {
  const defaults = { sides: 6, radius: 120, rotation: -90 };
  const config = await configFromParamsOrPrompt("Generate polygon / 生成多边形", defaults);
  if (!config) return false;
  const sides = positiveInteger(config.sides, defaults.sides, 100);
  if (sides < 3) throw new Error("A polygon needs at least 3 sides.");
  const radius = positiveNumber(config.radius, defaults.radius);
  const rotation = toFiniteNumber(config.rotation, defaults.rotation);
  const center = ea.getViewCenterPosition?.() || { x: 0, y: 0 };
  const id = ea.addLine(polygonPoints(center.x, center.y, radius, sides, rotation));
  const element = ea.getElement(id);
  element.customData = {
    ...(element.customData || {}),
    polygon: { sides, radius, rotation },
    openActionVersion: OPEN_ACTION_VERSION,
  };
  return commitCreated([id], false);
}

async function generateHexGrid() {
  const defaults = { rows: 4, columns: 5, radius: 46, gap: 8 };
  const config = await configFromParamsOrPrompt("Generate hex shape grid / 生成六边形网格", defaults);
  if (!config) return false;
  const rows = positiveInteger(config.rows, defaults.rows, 100);
  const columns = positiveInteger(config.columns, defaults.columns, 100);
  const radius = positiveNumber(config.radius, defaults.radius);
  const gap = Math.max(0, toFiniteNumber(config.gap, defaults.gap));
  const stepX = radius * 1.5 + gap;
  const stepY = Math.sqrt(3) * radius + gap;
  const totalWidth = radius * 2 + (columns - 1) * stepX;
  const totalHeight = stepY * rows + (columns > 1 ? stepY / 2 : 0);
  const origin = sceneCenterOrigin(totalWidth, totalHeight);
  const ids = [];

  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      const centerX = origin.x + radius + column * stepX;
      const centerY =
        origin.y + stepY / 2 + row * stepY + (column % 2 ? stepY / 2 : 0);
      const id = ea.addLine(polygonPoints(centerX, centerY, radius, 6, 0));
      const element = ea.getElement(id);
      element.customData = {
        ...(element.customData || {}),
        shapeGrid: { kind: "hexagon", row, col: column, rows, columns },
        openActionVersion: OPEN_ACTION_VERSION,
      };
      ids.push(id);
    }
  }
  return commitCreated(ids);
}

async function generateShapeGrid() {
  const defaults = {
    rows: 4,
    columns: 4,
    shape: "rectangle",
    width: 100,
    height: 70,
    gapX: 20,
    gapY: 20,
  };
  const config = await configFromParamsOrPrompt("Generate shape grid / 生成形状网格", defaults);
  if (!config) return false;
  const rows = positiveInteger(config.rows, defaults.rows, 100);
  const columns = positiveInteger(config.columns, defaults.columns, 100);
  const width = positiveNumber(config.width, defaults.width);
  const height = positiveNumber(config.height, defaults.height);
  const gapX = toFiniteNumber(config.gapX, defaults.gapX);
  const gapY = toFiniteNumber(config.gapY, defaults.gapY);
  const shape = String(config.shape || defaults.shape).toLowerCase();
  const totalWidth = columns * width + (columns - 1) * gapX;
  const totalHeight = rows * height + (rows - 1) * gapY;
  const origin = sceneCenterOrigin(totalWidth, totalHeight);
  const ids = [];

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = origin.x + column * (width + gapX);
      const y = origin.y + row * (height + gapY);
      let id;
      if (shape === "ellipse" || shape === "circle") {
        id = ea.addEllipse(x, y, width, shape === "circle" ? width : height);
      } else if (shape === "diamond") {
        id = ea.addDiamond(x, y, width, height);
      } else if (shape === "hexagon") {
        const radius = Math.min(width / 2, height / Math.sqrt(3));
        id = ea.addLine(
          polygonPoints(x + width / 2, y + height / 2, radius, 6, 0),
        );
      } else {
        id = ea.addRect(x, y, width, height);
      }
      const element = ea.getElement(id);
      element.customData = {
        ...(element.customData || {}),
        shapeGrid: { kind: shape, row, col: column, rows, columns },
        openActionVersion: OPEN_ACTION_VERSION,
      };
      ids.push(id);
    }
  }
  return commitCreated(ids);
}

function cloneSelectionForGrid(sourceElements, offsetX, offsetY) {
  const clones = ea.cloneElements
    ? ea.cloneElements(sourceElements)
    : sourceElements.map((element) => ea.cloneElement(element));
  const sourceIds = new Set(sourceElements.map((element) => element.id));
  const cloneIds = new Set(clones.map((element) => element.id));
  const cellGroupId = ea.generateElementId();

  for (const clone of clones) {
    clone.x += offsetX;
    clone.y += offsetY;
    clone.groupIds = [...(clone.groupIds || []), cellGroupId];
    clone.version = Math.max(1, toFiniteNumber(clone.version, 1) + 1);
    clone.versionNonce = Math.floor(Math.random() * 2147483647);
    clone.seed = Math.floor(Math.random() * 2147483647);
    if (clone.containerId && !cloneIds.has(clone.containerId)) clone.containerId = null;
    if (clone.frameId && !cloneIds.has(clone.frameId)) clone.frameId = null;
    if (clone.startBinding && !cloneIds.has(clone.startBinding.elementId)) {
      clone.startBinding = null;
    }
    if (clone.endBinding && !cloneIds.has(clone.endBinding.elementId)) {
      clone.endBinding = null;
    }
    if (Array.isArray(clone.boundElements)) {
      clone.boundElements = clone.boundElements.filter(
        (binding) => cloneIds.has(binding.id) || sourceIds.has(binding.id),
      );
    }
  }
  return clones;
}

async function gridSelected() {
  const defaults = { rows: 4, columns: 4, gapX: 0, gapY: 0, includeOriginal: true };
  const config = await configFromParamsOrPrompt("Grid selected elements / 选中对象网格化", defaults);
  if (!config) return false;
  const selected = selectedElements();
  if (!selected.length) throw new Error("Select one or more elements first.");
  const source = addBoundText(selected);
  const box = ea.getBoundingBox(source);
  const rows = positiveInteger(config.rows, defaults.rows, 50);
  const columns = positiveInteger(config.columns, defaults.columns, 50);
  const gapX = toFiniteNumber(config.gapX, defaults.gapX);
  const gapY = toFiniteNumber(config.gapY, defaults.gapY);
  const includeOriginal = boolValue(config.includeOriginal, defaults.includeOriginal);
  const clones = [];

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (includeOriginal && row === 0 && column === 0) continue;
      clones.push(
        ...cloneSelectionForGrid(
          source,
          column * (box.width + gapX),
          row * (box.height + gapY),
        ),
      );
    }
  }
  if (!clones.length) return false;
  ea.clear();
  ea.copyViewElementsToEAforEditing(clones);
  await ea.addElementsToView(false, true, false);
  const selectedIds = [
    ...(includeOriginal ? selected.map((element) => element.id) : []),
    ...clones.map((element) => element.id),
  ];
  ea.selectElementsInView?.(selectedIds);
  return true;
}

async function horizontalAlign() {
  const units = layoutUnits();
  const selectedIds = selectedElements().map((element) => element.id);
  const mode = String(param("align", "center"));
  const boxes = units.map((unit) => ea.getBoundingBox(unit));
  const allBox = ea.getBoundingBox(uniqueById(units.flat()));
  const target =
    mode === "top"
      ? allBox.topY
      : mode === "bottom"
      ? allBox.topY + allBox.height
      : allBox.topY + allBox.height / 2;
  const translations = boxes.map((box) => ({
    x: 0,
    y:
      target -
      (mode === "top"
        ? box.topY
        : mode === "bottom"
        ? box.topY + box.height
        : box.topY + box.height / 2),
  }));
  await applyUnitTranslations(units, translations, selectedIds);
  return true;
}

async function verticalAlign() {
  const units = layoutUnits();
  const selectedIds = selectedElements().map((element) => element.id);
  const mode = String(param("align", "center"));
  const boxes = units.map((unit) => ea.getBoundingBox(unit));
  const allBox = ea.getBoundingBox(uniqueById(units.flat()));
  const target =
    mode === "left"
      ? allBox.topX
      : mode === "right"
      ? allBox.topX + allBox.width
      : allBox.topX + allBox.width / 2;
  const translations = boxes.map((box) => ({
    x:
      target -
      (mode === "left"
        ? box.topX
        : mode === "right"
        ? box.topX + box.width
        : box.topX + box.width / 2),
    y: 0,
  }));
  await applyUnitTranslations(units, translations, selectedIds);
  return true;
}

async function distribute(axis) {
  const units = layoutUnits();
  if (units.length < 3) throw new Error("Select at least three layout groups.");
  const selectedIds = selectedElements().map((element) => element.id);
  const mode = String(param("mode", "centers"));
  const records = units.map((unit, originalIndex) => {
    const box = ea.getBoundingBox(unit);
    return { unit, box, originalIndex };
  });
  records.sort((a, b) =>
    axis === "x" ? a.box.topX - b.box.topX : a.box.topY - b.box.topY,
  );
  const translations = units.map(() => ({ x: 0, y: 0 }));

  if (mode === "gaps") {
    const first = records[0].box;
    const last = records[records.length - 1].box;
    const outerStart = axis === "x" ? first.topX : first.topY;
    const outerEnd =
      axis === "x" ? last.topX + last.width : last.topY + last.height;
    const totalSize = records.reduce(
      (sum, record) => sum + (axis === "x" ? record.box.width : record.box.height),
      0,
    );
    const gap = (outerEnd - outerStart - totalSize) / (records.length - 1);
    let cursor = outerStart;
    records.forEach((record) => {
      const current = axis === "x" ? record.box.topX : record.box.topY;
      const delta = cursor - current;
      translations[record.originalIndex][axis] = delta;
      cursor += (axis === "x" ? record.box.width : record.box.height) + gap;
    });
  } else {
    const centers = records.map((record) =>
      axis === "x"
        ? record.box.topX + record.box.width / 2
        : record.box.topY + record.box.height / 2,
    );
    const step = (centers[centers.length - 1] - centers[0]) / (records.length - 1);
    records.forEach((record, index) => {
      translations[record.originalIndex][axis] = centers[0] + index * step - centers[index];
    });
  }
  await applyUnitTranslations(units, translations, selectedIds);
  return true;
}

async function normalizeArrowEndpoints() {
  const gap = Math.max(0.01, toFiniteNumber(param("gap", 8), 8));
  const scene = liveSceneElements();
  const elementsById = new Map(scene.map((element) => [element.id, element]));
  const arrows = uniqueById(
    (ea.getMaximumGroups?.(selectedElements()) || [])
      .flat()
      .filter((element) => element.type === "arrow"),
  );
  if (!arrows.length) throw new Error("Select one or more arrows first.");

  await mutateSelected(
    arrows,
    (arrow) => {
      const startTarget = elementsById.get(arrow.startBinding?.elementId);
      const endTarget = elementsById.get(arrow.endBinding?.elementId);
      if (startTarget && arrow.startBinding) {
        const targetCenter = [
          startTarget.x + startTarget.width / 2,
          startTarget.y + startTarget.height / 2,
        ];
        const otherPoint =
          arrow.points.length <= 2 && endTarget
            ? [endTarget.x + endTarget.width / 2, endTarget.y + endTarget.height / 2]
            : [arrow.x + arrow.points[1][0], arrow.y + arrow.points[1][1]];
        arrow.startBinding.gap = gap;
        arrow.startBinding.focus = 0;
        const intersections = ea.intersectElementWithLine(
          startTarget,
          otherPoint,
          targetCenter,
          gap,
        );
        if (intersections.length) {
          const [nextX, nextY] = intersections[0];
          const shiftX = nextX - arrow.x;
          const shiftY = nextY - arrow.y;
          arrow.points = arrow.points.map((point, index) =>
            index === 0 ? [0, 0] : [point[0] - shiftX, point[1] - shiftY],
          );
          arrow.x = nextX;
          arrow.y = nextY;
        }
      }
      if (endTarget && arrow.endBinding) {
        const targetCenter = [
          endTarget.x + endTarget.width / 2,
          endTarget.y + endTarget.height / 2,
        ];
        const previousIndex = Math.max(0, arrow.points.length - 2);
        const otherPoint =
          arrow.points.length <= 2 && startTarget
            ? [startTarget.x + startTarget.width / 2, startTarget.y + startTarget.height / 2]
            : [
                arrow.x + arrow.points[previousIndex][0],
                arrow.y + arrow.points[previousIndex][1],
              ];
        arrow.endBinding.gap = gap;
        arrow.endBinding.focus = 0;
        const intersections = ea.intersectElementWithLine(
          endTarget,
          otherPoint,
          targetCenter,
          gap,
        );
        if (intersections.length) {
          arrow.points[arrow.points.length - 1] = [
            intersections[0][0] - arrow.x,
            intersections[0][1] - arrow.y,
          ];
        }
      }
      if (arrow.elbowed) arrow.fixedSegments = null;
    },
    arrows.map((arrow) => arrow.id),
  );
  return true;
}

function orthogonalRoute(points, route) {
  if (points.length < 2) return points;
  const result = [[...points[0]]];
  for (let index = 1; index < points.length; index++) {
    const previous = result[result.length - 1];
    const next = points[index];
    if (previous[0] !== next[0] && previous[1] !== next[1]) {
      const horizontalFirst =
        route === "horizontal-first" ||
        (route === "auto" && Math.abs(next[0] - previous[0]) >= Math.abs(next[1] - previous[1]));
      result.push(
        horizontalFirst ? [next[0], previous[1]] : [previous[0], next[1]],
      );
    }
    result.push([...next]);
  }
  return result.filter(
    (point, index) =>
      index === 0 ||
      point[0] !== result[index - 1][0] ||
      point[1] !== result[index - 1][1],
  );
}

function clearCurveArrowMetadata(element) {
  if (!element.customData) return;
  const customData = { ...element.customData };
  delete customData.curveArrow;
  element.customData = customData;
}

async function lineToRightAngle(multipoints) {
  const route = String(param("route", "auto"));
  const useNativeElbow = boolValue(param("nativeElbow", true), true);
  const lines = selectedElements().filter(
    (element) => element.type === "line" || element.type === "arrow",
  );
  if (!lines.length) throw new Error("Select one or more lines or arrows first.");
  await mutateSelected(
    lines,
    (line) => {
      const sourcePoints = multipoints
        ? line.points.map((point) => [...point])
        : [[...line.points[0]], [...line.points[line.points.length - 1]]];
      line.points = orthogonalRoute(sourcePoints, route);
      line.roundness = null;
      clearCurveArrowMetadata(line);
      if (line.type === "arrow") {
        line.elbowed = !multipoints && useNativeElbow;
        line.fixedSegments = null;
        line.startIsSpecial = null;
        line.endIsSpecial = null;
      }
    },
    lines.map((line) => line.id),
  );
  return true;
}

async function setAngle() {
  const defaults = { angle: 0 };
  const config = await configFromParamsOrPrompt("Set angle in degrees / 设置角度", defaults);
  if (!config) return false;
  const selected = selectedElements();
  if (!selected.length) throw new Error("Select one or more elements first.");
  const radians = (toFiniteNumber(config.angle, defaults.angle) * Math.PI) / 180;
  return mutateSelected(selected, (element) => {
    element.angle = radians;
  });
}

const ARROWHEAD_VALUES = new Set([
  "arrow",
  "chevron",
  "chevron_outline",
  "block_arrow",
  "block_arrow_outline",
  "bar",
  "circle",
  "circle_outline",
  "triangle",
  "triangle_outline",
  "diamond",
  "diamond_outline",
  "cardinality_one",
  "cardinality_many",
  "cardinality_one_or_many",
  "cardinality_exactly_one",
  "cardinality_zero_or_one",
  "cardinality_zero_or_many",
]);

function normalizedArrowhead(value, existing) {
  if (value === undefined || value === "keep") return existing;
  if (value === null || value === "none" || value === "null") return null;
  const stringValue = String(value);
  if (!ARROWHEAD_VALUES.has(stringValue)) {
    throw new Error(`Unsupported arrowhead type: ${stringValue}`);
  }
  return stringValue;
}

function applyCurveStyle(arrow, curveStyle) {
  if (!curveStyle || curveStyle === "keep") return;
  const first = [...arrow.points[0]];
  const last = [...arrow.points[arrow.points.length - 1]];
  if (curveStyle === "automatic") {
    arrow.elbowed = false;
    arrow.roundness = null;
    arrow.points = [first, last];
    arrow.customData = { ...(arrow.customData || {}), curveArrow: true };
    delete arrow.fixedSegments;
    return;
  }
  clearCurveArrowMetadata(arrow);
  if (curveStyle === "elbow") {
    arrow.elbowed = true;
    arrow.roundness = null;
    arrow.points = orthogonalRoute([first, last], "auto");
    arrow.fixedSegments = null;
    arrow.startIsSpecial = null;
    arrow.endIsSpecial = null;
  } else if (curveStyle === "round") {
    arrow.elbowed = false;
    arrow.roundness = { type: 2 };
    delete arrow.fixedSegments;
  } else {
    arrow.elbowed = false;
    arrow.roundness = null;
    delete arrow.fixedSegments;
  }
}

async function setArrowType() {
  const defaults = { startArrowhead: "keep", endArrowhead: "arrow", curveStyle: "keep" };
  const config = await configFromParamsOrPrompt("Set arrow type / 设置箭头类型", defaults);
  if (!config) return false;
  const lines = selectedElements().filter(
    (element) => element.type === "line" || element.type === "arrow",
  );
  if (!lines.length) throw new Error("Select one or more lines or arrows first.");
  await mutateSelected(lines, (line) => {
    line.startArrowhead = normalizedArrowhead(config.startArrowhead, line.startArrowhead);
    line.endArrowhead = normalizedArrowhead(config.endArrowhead, line.endArrowhead);
    if (line.type === "arrow") applyCurveStyle(line, String(config.curveStyle || "keep"));
  });
  return true;
}

function selectedTextElements() {
  const selected = selectedElements();
  const elementsById = sceneMap();
  const texts = selected.filter((element) => element.type === "text");
  for (const element of selected) {
    for (const binding of element.boundElements || []) {
      if (binding.type !== "text") continue;
      const text = elementsById.get(binding.id);
      if (text?.type === "text") texts.push(text);
    }
  }
  return uniqueById(texts);
}

async function setFontSize() {
  const defaults = { fontSize: 24 };
  const config = await configFromParamsOrPrompt("Set font size / 设置字号", defaults);
  if (!config) return false;
  const fontSize = positiveNumber(config.fontSize, defaults.fontSize, 1000);
  const texts = selectedTextElements();
  if (!texts.length) throw new Error("Select text or a container with bound text first.");
  await mutateSelected(
    texts,
    (text, source) => {
      const ratio = fontSize / Math.max(1, source.fontSize || fontSize);
      const previousWidth = source.width;
      const previousHeight = source.height;
      text.fontSize = fontSize;
      if (!source.containerId && source.autoResize !== false) {
        ea.refreshTextElementSize?.(text.id);
        if (source.textAlign === "center") text.x += (previousWidth - text.width) / 2;
        if (source.textAlign === "right") text.x += previousWidth - text.width;
        text.y += (previousHeight - text.height) / 2;
      } else {
        text.width = previousWidth;
        text.height = Math.max(1, previousHeight * ratio);
      }
      if (typeof source.baseline === "number") text.baseline = source.baseline * ratio;
    },
    selectedElements().map((element) => element.id),
  );
  return true;
}

function textMeasure(textElement, value) {
  const previousFontSize = ea.style.fontSize;
  const previousFontFamily = ea.style.fontFamily;
  ea.style.fontSize = textElement.fontSize;
  ea.style.fontFamily = textElement.fontFamily;
  const measured = ea.measureText(value);
  ea.style.fontSize = previousFontSize;
  ea.style.fontFamily = previousFontFamily;
  return measured;
}

function wordSegments(text) {
  try {
    if (typeof Intl?.Segmenter === "function") {
      return [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)].map(
        (entry) => entry.segment,
      );
    }
  } catch (_error) {}
  return text.match(/\s+|[^\s]+/gu) || [];
}

function splitTokenToFit(textElement, token, maxWidth) {
  const parts = [];
  let current = "";
  for (const character of [...token]) {
    const candidate = current + character;
    if (current && textMeasure(textElement, candidate).width > maxWidth) {
      parts.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function wrapParagraph(textElement, paragraph, maxWidth) {
  if (!paragraph) return "";
  const lines = [];
  let current = "";
  for (const token of wordSegments(paragraph)) {
    const candidate = current + token;
    if (!current || textMeasure(textElement, candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    lines.push(current.trimEnd());
    const tokenWithoutLeadingSpace = token.trimStart();
    if (textMeasure(textElement, tokenWithoutLeadingSpace).width <= maxWidth) {
      current = tokenWithoutLeadingSpace;
      continue;
    }
    const pieces = splitTokenToFit(textElement, tokenWithoutLeadingSpace, maxWidth);
    lines.push(...pieces.slice(0, -1));
    current = pieces[pieces.length - 1] || "";
  }
  if (current || !lines.length) lines.push(current.trimEnd());
  return lines.join("\n");
}

async function wrapText() {
  const defaults = { width: 240 };
  const config = await configFromParamsOrPrompt("Wrap text by pixel width / 按像素宽度换行", defaults);
  if (!config) return false;
  const requestedWidth = positiveNumber(config.width, defaults.width);
  const texts = selectedTextElements();
  if (!texts.length) throw new Error("Select text or a container with bound text first.");
  const elementsById = sceneMap();
  await mutateSelected(
    texts,
    (text, source) => {
      const container = source.containerId ? elementsById.get(source.containerId) : null;
      const maxWidth = container
        ? Math.max(20, Math.min(requestedWidth, container.width - 20))
        : requestedWidth;
      const original = String(source.originalText ?? source.rawText ?? source.text ?? "");
      const wrapped = original
        .split(/\r?\n/u)
        .map((paragraph) => wrapParagraph(source, paragraph, maxWidth))
        .join("\n");
      const previousWidth = source.width;
      const previousHeight = source.height;
      text.text = wrapped;
      text.originalText = wrapped;
      if (Object.prototype.hasOwnProperty.call(text, "rawText")) text.rawText = wrapped;
      ea.refreshTextElementSize?.(text.id);
      if (container || source.autoResize === false) {
        text.width = previousWidth;
      } else {
        if (source.textAlign === "center") text.x += (previousWidth - text.width) / 2;
        if (source.textAlign === "right") text.x += previousWidth - text.width;
        text.y += (previousHeight - text.height) / 2;
      }
    },
    selectedElements().map((element) => element.id),
  );
  return true;
}

const HANDLERS = {
  "script.generate.cuboid": generateCuboid,
  "script.generate.table": generateTable,
  "script.geometry.generate-polygon": generatePolygon,
  "script.geometry.hex-shape-grid": generateHexGrid,
  "script.geometry.shape-grid": generateShapeGrid,
  "script.layout.grid-selected": gridSelected,
  "script.layout.horizontal-align": horizontalAlign,
  "script.layout.horizontal-distribute": () => distribute("x"),
  "script.layout.vertical-align": verticalAlign,
  "script.layout.vertical-distribute": () => distribute("y"),
  "script.line.normalize-arrow-endpoints": normalizeArrowEndpoints,
  "script.line.to-right-angle": () => lineToRightAngle(false),
  "script.line.to-right-angle-multipoints": () => lineToRightAngle(true),
  "script.style.set-angle": setAngle,
  "script.style.set-arrow-type": setArrowType,
  "script.style.set-font-size": setFontSize,
  "script.text.wrap": wrapText,
};

const handler = HANDLERS[actionId];
if (!handler) throw new Error(`Unknown open replacement action: ${actionId}`);
const changed = await handler();
if (changed && !actionRequest) {
  new Notice(`${ACTION_LABELS[actionId] || actionId} completed.`);
}
return { actionId, changed: !!changed, version: OPEN_ACTION_VERSION };
