/*
Reverse arrow direction (geometry)

真正反转所选箭头的几何方向，而不是交换 startArrowhead 与 endArrowhead。

- 保留 startArrowhead / endArrowhead 的类型和值；
- 反转点序列，因此动态线条的运动方向也会反转；
- 交换起点/终点绑定，并保留折线、曲线和 Automatic Curve 元数据；
- 对 Elbow Arrow 同步反转固定线段与端点特殊状态。

```javascript
*/
const selectedArrows = (ea.getViewSelectedElements?.() || []).filter(
  (element) =>
    element?.type === "arrow" &&
    !element.isDeleted &&
    Array.isArray(element.points) &&
    element.points.length >= 2,
);

if (selectedArrows.length === 0) {
  new Notice("请至少选择一个箭头。 / Select at least one arrow.");
  return;
}

const selectedIds = new Set(selectedArrows.map((element) => element.id));
ea.copyViewElementsToEAforEditing(selectedArrows);

const editableArrows = (ea.getElements?.() || []).filter((element) =>
  selectedIds.has(element.id),
);

for (const arrow of editableArrows) {
  reverseArrowGeometry(arrow);
}

await ea.addElementsToView(false, false);
new Notice(
  `已真正反转 ${editableArrows.length} 个箭头的方向。 / Reversed ${editableArrows.length} arrow(s).`,
);

function reverseArrowGeometry(arrow) {
  const originalPoints = arrow.points.map((point) => [point[0], point[1]]);
  const terminalPoint = originalPoints[originalPoints.length - 1];

  arrow.x += terminalPoint[0];
  arrow.y += terminalPoint[1];
  arrow.points = originalPoints
    .slice()
    .reverse()
    .map((point) => [
      point[0] - terminalPoint[0],
      point[1] - terminalPoint[1],
    ]);

  const originalStartBinding = arrow.startBinding ?? null;
  arrow.startBinding = arrow.endBinding ?? null;
  arrow.endBinding = originalStartBinding;

  if (Array.isArray(arrow.fixedSegments)) {
    arrow.fixedSegments = arrow.fixedSegments
      .map((segment) => ({
        index: originalPoints.length - segment.index,
        start: [
          segment.end[0] - terminalPoint[0],
          segment.end[1] - terminalPoint[1],
        ],
        end: [
          segment.start[0] - terminalPoint[0],
          segment.start[1] - terminalPoint[1],
        ],
      }))
      .sort((left, right) => left.index - right.index);
  }

  if ("startIsSpecial" in arrow || "endIsSpecial" in arrow) {
    const originalStartIsSpecial = arrow.startIsSpecial ?? null;
    arrow.startIsSpecial = arrow.endIsSpecial ?? null;
    arrow.endIsSpecial = originalStartIsSpecial;
  }
}
