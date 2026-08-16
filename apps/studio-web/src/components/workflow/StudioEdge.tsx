import { createContext, useContext } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import { PlusOutlined } from "../../lib/icons.js";

export const WorkflowEdgeActionsContext = createContext<
  ((edgeId: string, anchor: { x: number; y: number }) => void) | null
>(null);

export function StudioEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  label,
  selected,
}: EdgeProps) {
  const openNodePicker = useContext(WorkflowEdgeActionsContext);
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
  });
  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        {label ? (
          <span
            className="workflow-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 19}px)` }}
          >
            {String(label)}
          </span>
        ) : null}
        <button
          className={`workflow-edge-add nodrag nopan${selected ? " is-selected" : ""}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          type="button"
          title="在连接中插入节点"
          aria-label="在连接中插入节点"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            openNodePicker?.(id, { x: event.clientX, y: event.clientY });
          }}
        >
          <PlusOutlined />
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
