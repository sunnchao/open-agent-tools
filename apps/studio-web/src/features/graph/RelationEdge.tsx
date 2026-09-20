import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import type { RelationFlowEdge } from "./relationRouting.js";

export function RelationEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  label,
  labelStyle,
  data,
  interactionWidth,
}: EdgeProps<RelationFlowEdge>) {
  const offset = data?.curveOffset ?? 0;
  let path: string;
  let labelX: number;
  let labelY: number;

  if (source === target) {
    const side = offset < 0 ? 1 : -1;
    const loopSize = 52 + Math.abs(offset);
    path = `M ${sourceX},${sourceY} C ${sourceX + loopSize},${sourceY + side * loopSize} ${targetX - loopSize},${targetY + side * loopSize} ${targetX},${targetY}`;
    labelX = (sourceX + targetX) / 2;
    labelY = Math.min(sourceY, targetY) + side * loopSize * 0.75;
  } else {
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;
    const length = Math.max(1, Math.hypot(dx, dy));
    const normalX = -dy / length;
    const normalY = dx / length;
    const controlX = (sourceX + targetX) / 2 + normalX * offset * 2;
    const controlY = (sourceY + targetY) / 2 + normalY * offset * 2;
    labelX = (sourceX + 2 * controlX + targetX) / 4;
    labelY = (sourceY + 2 * controlY + targetY) / 4;
    path = `M ${sourceX},${sourceY} Q ${controlX},${controlY} ${targetX},${targetY}`;
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={interactionWidth ?? 24}
      />
      {label && data?.showLabel !== false ? (
        <EdgeLabelRenderer>
          <span
            className="graph-relation-label nodrag nopan"
            style={{
              ...labelStyle,
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {String(label)}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
