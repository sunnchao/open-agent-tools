import {
  runVariables,
  validVariableName,
  cachedNodesFromEvents,
  prepareResumeCheckpoint,
  type WorkflowResumeCheckpoint,
} from "@open-agent-tools/workflow-contracts";
import { variableNodes, renameVariable, repairVariableReference } from "./variables.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, Badge, Button, Empty, Flex, Input, Segmented, Spin, Tag, Tooltip, Typography } from "antd";
import "./workflow-panels.css";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  BranchesOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  PauseCircleOutlined,
  PanelLeftCloseOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RedoOutlined,
  RocketOutlined,
  SaveOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  UndoOutlined,
  ApiOutlined,
} from "../../lib/icons.js";
import { useResourceCatalog } from "../../features/resources/useResourceCatalog.js";
import { fetchProviders, type ProviderMetadata } from "../../features/providers/api.js";
import { streamWorkflow, testWorkflowNode, type WorkflowNodeTestResult } from "../../lib/api.js";
import { createNodeTestInputDraft, parseNodeTestValue } from "./nodeTest.js";
import {
  nodeInputs,
  validateWorkflowGraph,
  type NodeKind,
  type WorkflowConfigValue,
  type WorkflowNodeData,
  type WorkflowValidationIssue,
} from "./model.js";
import {
  createEdge,
  createNode,
  historyLimit,
  hydrateWorkflowSnapshot,
  initialEdges,
  initialNodes,
  snapshotGraph,
  snapshotKey,
} from "./graph.js";
import { iconByKind, nodeColor, palette } from "./palette.js";
import { StudioNode, WorkflowBranchActionsContext } from "./StudioNode.js";
import {
  branchIdOf,
  canConnectTarget,
  configureBranchEdge,
  conditionBranches,
  updateConditionGraph,
} from "./condition.js";
import { StudioEdge, WorkflowEdgeActionsContext } from "./StudioEdge.js";
import { NodePicker } from "./NodePicker.js";
import { NodeInspector } from "./NodeInspector.js";
import { RunPreview } from "./RunPreview.js";
import { RunHistoryPanel } from "./RunHistoryPanel.js";
import { decorateRunEdges, updateRunEdges, type EdgeRunStates } from "./runEdges.js";
import { RunInputDialog } from "./RunInputDialog.js";
import { PublishDialog } from "./PublishDialog.js";
import { ResumeDialog } from "./ResumeDialog.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { downloadWorkflow } from "./io.js";
import { cloneSubgraph } from "./subgraph.js";
import { layoutWorkflow } from "./layout.js";
import { assertSelectionSources, parseSelection, serializeSelection } from "./clipboard.js";
import { NodeTestInputDialog } from "./NodeTestInputDialog.js";
import type {
  NodePickerState,
  RunLogEntry,
  WorkflowNode,
  WorkflowSnapshot,
  WorkflowEdge,
} from "./types.js";
import {
  fetchWorkflow,
  publishWorkflow,
  saveWorkflowDraft,
  type WorkflowDetailRecord,
  type WorkflowRunHistory,
} from "./api.js";

interface NodeTestDialogState {
  nodeId: string;
  values: Record<string, string>;
}

type WorkflowMobileView = "palette" | "canvas" | "inspector";

const nodeTypes = { studio: StudioNode };
const edgeTypes = { studio: StudioEdge };

export function WorkflowEditor({
  workflowId,
  onBack,
  onOpenAccess,
}: {
  workflowId: string;
  onBack: () => void;
  onOpenAccess: () => void;
}) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvas workflowId={workflowId} onBack={onBack} onOpenAccess={onOpenAccess} />
    </ReactFlowProvider>
  );
}

function WorkflowCanvas({
  workflowId,
  onBack,
  onOpenAccess,
}: {
  workflowId: string;
  onBack: () => void;
  onOpenAccess: () => void;
}) {
  const resources = useResourceCatalog();
  const [providers, setProviders] = useState<ProviderMetadata[]>([]);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowDetailRecord | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [publishState, setPublishState] = useState<"idle" | "publishing" | "error">("idle");
  const [showPublish, setShowPublish] = useState(false);
  const [publishNotice, setPublishNotice] = useState("");
  const [confirmExport, setConfirmExport] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ nodes: string[]; edges: string[] } | null>(
    null,
  );
  const [pendingResume, setPendingResume] = useState<{
    history: WorkflowRunHistory;
    checkpoint: WorkflowResumeCheckpoint;
  } | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<WorkflowEdge>(initialEdges);
  const [name, setName] = useState("知识库问答工作流");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<WorkflowMobileView>("canvas");
  const [compactLayout, setCompactLayout] = useState(
    () => window.matchMedia("(max-width: 1024px)").matches,
  );
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [paletteQuery, setPaletteQuery] = useState("");
  const [nodePicker, setNodePicker] = useState<NodePickerState | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [editRevision, setEditRevision] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [running, setRunning] = useState(false);
  const [inspectorView, setInspectorView] = useState<"current" | "history">("current");
  const [runHistoryRevision, setRunHistoryRevision] = useState(0);
  const [runLog, setRunLog] = useState<RunLogEntry[]>([]);
  const [edgeRunStates, setEdgeRunStates] = useState<EdgeRunStates>({});
  const runIncomingEdges = useRef<Record<string, string[]>>({});
  const [runOutputs, setRunOutputs] = useState<Record<string, Record<string, unknown>> | null>(
    null,
  );
  const [finalOutputs, setFinalOutputs] = useState<Record<string, unknown> | null>(null);
  const [runInputs, setRunInputs] = useState<Record<string, string>>({});
  const [showRunInputs, setShowRunInputs] = useState(false);
  const [nodeTestDialog, setNodeTestDialog] = useState<NodeTestDialogState | null>(null);
  const [nodeTestPendingId, setNodeTestPendingId] = useState<string | null>(null);
  const [nodeTestResults, setNodeTestResults] = useState<Record<string, WorkflowNodeTestResult>>(
    {},
  );
  const runToken = useRef(0);
  const runController = useRef<AbortController | null>(null);
  const nodeTestToken = useRef(0);
  const nodeTestController = useRef<AbortController | null>(null);
  const flowCanvasRef = useRef<HTMLDivElement>(null);
  const historyTimer = useRef<number | null>(null);
  const draftRevisionRef = useRef(1);
  const loadedRef = useRef(false);
  const savePromiseRef = useRef<Promise<number | null> | null>(null);
  const pendingSaveRef = useRef(false);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const nameRef = useRef(name);
  const historyRef = useRef<WorkflowSnapshot[]>([]);
  const historyIndexRef = useRef(0);
  const { screenToFlowPosition, getNode, setCenter, fitView } = useReactFlow();

  nodesRef.current = nodes;
  edgesRef.current = edges;
  nameRef.current = name;
  if (historyRef.current.length === 0) {
    historyRef.current = [snapshotGraph(name, nodes, edges)];
  }

  const validationIssues = useMemo(
    () => validateWorkflowGraph(nodes, edges, resources.catalog),
    [edges, nodes, resources.catalog],
  );
  const filteredPalette = useMemo(() => {
    const query = paletteQuery.trim().toLocaleLowerCase();
    if (!query) return palette;
    return palette.filter((item) =>
      `${item.label} ${item.description} ${item.group} ${item.kind}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [paletteQuery]);
  const currentSnapshotKey = useMemo(
    () => snapshotKey(snapshotGraph(name, nodes, edges)),
    [edges, name, nodes],
  );
  const historySnapshotKey = snapshotKey(historyRef.current[historyIndexRef.current]!);
  const canUndo = historyIndexRef.current > 0 || currentSnapshotKey !== historySnapshotKey;
  const canRedo =
    currentSnapshotKey === historySnapshotKey &&
    historyIndexRef.current < historyRef.current.length - 1;

  const markEdited = useCallback(() => {
    setDirty(true);
    setSaveState("saving");
    setEditRevision((revision) => revision + 1);
  }, []);

  const commitHistory = useCallback(() => {
    const snapshot = snapshotGraph(nameRef.current, nodesRef.current, edgesRef.current);
    const current = historyRef.current[historyIndexRef.current];
    if (current && snapshotKey(current) === snapshotKey(snapshot)) return historyIndexRef.current;
    const next = historyRef.current.slice(0, historyIndexRef.current + 1);
    next.push(snapshot);
    if (next.length > historyLimit) next.shift();
    historyRef.current = next;
    historyIndexRef.current = next.length - 1;
    setHistoryRevision((revision) => revision + 1);
    return historyIndexRef.current;
  }, []);

  const applyHistory = useCallback(
    (index: number) => {
      const saved = historyRef.current[index];
      if (!saved) return;
      const snapshot = hydrateWorkflowSnapshot(saved);
      historyIndexRef.current = index;
      nameRef.current = snapshot.name;
      nodesRef.current = snapshot.nodes;
      edgesRef.current = snapshot.edges;
      setName(snapshot.name);
      setNodes(snapshot.nodes);
      setEdges(snapshot.edges);
      setSelectedId(null);
      setMobileView("canvas");
      setDirty(true);
      setSaveState("saving");
      setHistoryRevision((revision) => revision + 1);
    },
    [setEdges, setNodes],
  );

  const undo = useCallback(() => {
    if (historyTimer.current !== null) window.clearTimeout(historyTimer.current);
    const index = commitHistory();
    if (index > 0) applyHistory(index - 1);
  }, [applyHistory, commitHistory]);

  const redo = useCallback(() => {
    if (historyTimer.current !== null) window.clearTimeout(historyTimer.current);
    const index = commitHistory();
    if (index < historyRef.current.length - 1) applyHistory(index + 1);
  }, [applyHistory, commitHistory]);

  useEffect(
    () => () => {
      loadedRef.current = false;
      runToken.current += 1;
      runController.current?.abort();
      nodeTestToken.current += 1;
      nodeTestController.current?.abort();
      if (historyTimer.current !== null) window.clearTimeout(historyTimer.current);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    setWorkspaceLoading(true);
    setWorkspaceError(null);
    void fetchWorkflow(workflowId)
      .then(({ workflow: loaded }) => {
        if (cancelled) return;
        const snapshot = hydrateWorkflowSnapshot(loaded.draft);
        setWorkflow(loaded);
        setName(snapshot.name);
        setNodes(snapshot.nodes);
        setEdges(snapshot.edges);
        nodesRef.current = snapshot.nodes;
        edgesRef.current = snapshot.edges;
        nameRef.current = snapshot.name;
        draftRevisionRef.current = loaded.app.draftRevision;
        historyRef.current = [snapshotGraph(snapshot.name, snapshot.nodes, snapshot.edges)];
        historyIndexRef.current = 0;
        setHistoryRevision((revision) => revision + 1);
        setDirty(false);
        setSaveState("saved");
        loadedRef.current = true;
        window.requestAnimationFrame(() => {
          void fitView({ padding: 0.18, minZoom: 0.25, maxZoom: 0.9, duration: 180 });
        });
      })
      .catch((reason) => {
        if (!cancelled) {
          setWorkspaceError(reason instanceof Error ? reason.message : "工作流加载失败");
        }
      })
      .finally(() => {
        if (!cancelled) setWorkspaceLoading(false);
      });
    return () => {
      cancelled = true;
      loadedRef.current = false;
    };
  }, [fitView, setEdges, setNodes, workflowId]);

  useEffect(() => {
    let cancelled = false;
    void fetchProviders()
      .then((items) => {
        if (!cancelled) setProviders(items.filter((provider) => provider.enabled));
      })
      .catch((reason) => {
        if (!cancelled)
          setProviderError(reason instanceof Error ? reason.message : "Provider 加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1024px)");
    const update = () => setCompactLayout(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (editRevision === 0) return;
    if (historyTimer.current !== null) window.clearTimeout(historyTimer.current);
    historyTimer.current = window.setTimeout(() => {
      commitHistory();
      historyTimer.current = null;
    }, 280);
    return () => {
      if (historyTimer.current !== null) window.clearTimeout(historyTimer.current);
    };
  }, [commitHistory, editRevision]);

  const persistDraft = useCallback((): Promise<number | null> => {
    if (!loadedRef.current) return Promise.resolve(null);
    if (savePromiseRef.current) {
      pendingSaveRef.current = true;
      return savePromiseRef.current;
    }
    const operation = (async () => {
      let latestRevision: number | null = draftRevisionRef.current;
      try {
        do {
          pendingSaveRef.current = false;
          const snapshot = snapshotGraph(nameRef.current, nodesRef.current, edgesRef.current);
          const savedKey = snapshotKey(snapshot);
          setSaveState("saving");
          const saved = await saveWorkflowDraft(workflowId, draftRevisionRef.current, snapshot);
          latestRevision = saved.app.draftRevision;
          draftRevisionRef.current = saved.app.draftRevision;
          setWorkflow(saved);
          const currentKey = snapshotKey(
            snapshotGraph(nameRef.current, nodesRef.current, edgesRef.current),
          );
          if (currentKey !== savedKey) pendingSaveRef.current = true;
        } while (pendingSaveRef.current);
        setDirty(false);
        setSaveState("saved");
        setWorkspaceError(null);
        return latestRevision;
      } catch (reason) {
        setSaveState("error");
        setWorkspaceError(reason instanceof Error ? reason.message : "工作流保存失败");
        return null;
      } finally {
        savePromiseRef.current = null;
      }
    })();
    savePromiseRef.current = operation;
    return operation;
  }, [workflowId]);

  useEffect(() => {
    if (!dirty || !loadedRef.current) return;
    const timer = window.setTimeout(() => void persistDraft(), 700);
    return () => window.clearTimeout(timer);
  }, [dirty, editRevision, historyRevision, persistDraft]);

  const selectedNode = nodes.find((node) => node.id === selectedId) ?? null;
  const selectedNodes = nodes.filter((node) => node.selected);
  const selectedIds = selectedNodes.length
    ? selectedNodes.map((node) => node.id)
    : selectedId
      ? [selectedId]
      : [];

  const applyGraphEdit = useCallback(
    (nextNodes: WorkflowNode[], nextEdges: Edge[]) => {
      if (historyTimer.current !== null) window.clearTimeout(historyTimer.current);
      commitHistory();
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      setNodes(nextNodes);
      setEdges(nextEdges);
      commitHistory();
      markEdited();
    },
    [commitHistory, markEdited, setEdges, setNodes],
  );

  const focusRunNode = useCallback(
    (nodeId: string) => {
      const node = getNode(nodeId);
      if (!node) return;
      const width = node.measured?.width ?? node.width ?? 218;
      const height = node.measured?.height ?? node.height ?? 84;
      setCenter(node.position.x + width / 2, node.position.y + height / 2, {
        duration: 450,
      });
    },
    [getNode, setCenter],
  );

  const showCanvas = useCallback(() => {
    setMobileView("canvas");
    window.requestAnimationFrame(() => {
      void fitView({
        padding: 0.18,
        minZoom: compactLayout ? 0.25 : 0.5,
        maxZoom: compactLayout ? 0.7 : 1,
        duration: 240,
      });
    });
  }, [compactLayout, fitView]);

  useEffect(() => {
    if (!compactLayout || mobileView !== "canvas") return;
    const frame = window.requestAnimationFrame(() => {
      void fitView({ padding: 0.18, minZoom: 0.25, maxZoom: 0.7, duration: 180 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [compactLayout, fitView, mobileView]);

  const focusIssue = useCallback(
    (issue: WorkflowValidationIssue) => {
      setShowIssues(false);
      if (!issue.nodeId) return;
      setSelectedId(issue.nodeId);
      setMobileView("inspector");
      focusRunNode(issue.nodeId);
    },
    [focusRunNode],
  );

  const connect = useCallback(
    (connection: Connection) => {
      if (
        !connection.source ||
        !connection.target ||
        !canConnectTarget(connection.source, connection.target, nodesRef.current, edgesRef.current)
      )
        return;
      const source = nodesRef.current.find((node) => node.id === connection.source)!;
      let edge = createEdge(connection.source, connection.target);
      if (source.data.kind === "condition") {
        const branchId = connection.sourceHandle?.replace(/^branch:/, "");
        if (
          !branchId ||
          !conditionBranches(source.data.config).some((branch) => branch.id === branchId)
        )
          return;
        edge = configureBranchEdge(edge, source.data.config, branchId);
      }
      applyGraphEdit(nodesRef.current, addEdge(edge, edgesRef.current));
    },
    [applyGraphEdit],
  );

  const insertNode = useCallback(
    (kind: NodeKind, position: { x: number; y: number }) => {
      if (kind === "start" && nodesRef.current.some((node) => node.data.kind === "start")) return;
      const id = `${kind}-${Date.now()}`;
      setNodes((current) => [...current, createNode(id, kind, position)]);
      setSelectedId(id);
      markEdited();
    },
    [markEdited, setNodes],
  );

  const dropNode = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData("application/open-agent-node") as NodeKind;
      if (!palette.some((item) => item.kind === kind)) return;
      insertNode(kind, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [insertNode, screenToFlowPosition],
  );

  const addPaletteNode = useCallback(
    (kind: NodeKind) => {
      const rect = flowCanvasRef.current?.getBoundingClientRect();
      const graphCenter =
        nodes.length > 0
          ? {
              x: nodes.reduce((total, node) => total + node.position.x, 0) / nodes.length,
              y: nodes.reduce((total, node) => total + node.position.y, 0) / nodes.length,
            }
          : { x: 120, y: 120 };
      const position =
        rect && rect.width > 0 && rect.height > 0
          ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
          : {
              x: graphCenter.x + (nodes.length % 3) * 32,
              y: graphCenter.y + (nodes.length % 2) * 36,
            };
      insertNode(kind, position);
      setMobileView("inspector");
    },
    [insertNode, nodes, screenToFlowPosition],
  );

  const openNodePicker = useCallback(() => {
    const rect = flowCanvasRef.current?.getBoundingClientRect();
    const anchor =
      rect && rect.width > 0 && rect.height > 0
        ? { x: rect.left + rect.width / 2, y: rect.top + Math.min(180, rect.height / 2) }
        : { x: window.innerWidth / 2, y: Math.min(240, window.innerHeight / 2) };
    const position =
      rect && rect.width > 0 && rect.height > 0
        ? screenToFlowPosition(anchor)
        : {
            x:
              nodesRef.current.reduce((total, node) => total + node.position.x, 0) /
                Math.max(1, nodesRef.current.length) +
              80,
            y:
              nodesRef.current.reduce((total, node) => total + node.position.y, 0) /
              Math.max(1, nodesRef.current.length),
          };
    setMobileView("canvas");
    setNodePicker({ anchor, position });
  }, [screenToFlowPosition]);

  const openEdgeNodePicker = useCallback(
    (edgeId: string, anchor: { x: number; y: number }) => {
      const edge = edgesRef.current.find((item) => item.id === edgeId);
      const source = edge && nodesRef.current.find((node) => node.id === edge.source);
      const target = edge && nodesRef.current.find((node) => node.id === edge.target);
      setNodePicker({
        anchor,
        edgeId,
        position:
          source && target
            ? {
                x: source.position.x + (target.position.x - source.position.x) / 2,
                y: source.position.y + (target.position.y - source.position.y) / 2,
              }
            : screenToFlowPosition(anchor),
      });
    },
    [screenToFlowPosition],
  );

  const openBranchNodePicker = useCallback(
    (sourceNodeId: string, branchId: string, anchor: { x: number; y: number }) => {
      const source = nodesRef.current.find((node) => node.id === sourceNodeId);
      if (!source || running) return;
      const index = conditionBranches(source.data.config).findIndex(
        (branch) => branch.id === branchId,
      );
      if (index < 0) return;
      setNodePicker({
        anchor,
        sourceNodeId,
        branchId,
        position: {
          x: source.position.x + (source.measured?.width ?? 260) + 100,
          y: source.position.y + index * 150,
        },
      });
    },
    [running],
  );

  const chooseExistingNode = useCallback(
    (targetId: string) => {
      if (!nodePicker?.sourceNodeId || !nodePicker.branchId) return;
      const source = nodesRef.current.find((node) => node.id === nodePicker.sourceNodeId);
      if (
        !source ||
        !conditionBranches(source.data.config).some(
          (branch) => branch.id === nodePicker.branchId,
        ) ||
        !canConnectTarget(source.id, targetId, nodesRef.current, edgesRef.current)
      )
        return;
      const edge = configureBranchEdge(
        createEdge(source.id, targetId),
        source.data.config,
        nodePicker.branchId,
      );
      applyGraphEdit(nodesRef.current, addEdge(edge, edgesRef.current));
      setNodePicker(null);
    },
    [nodePicker, applyGraphEdit],
  );

  const chooseNode = useCallback(
    (kind: NodeKind) => {
      const picker = nodePicker;
      if (!picker) return;
      if (kind === "start" && nodesRef.current.some((node) => node.data.kind === "start")) return;
      const id = `${kind}-${Date.now()}`;
      const edge = picker.edgeId
        ? edgesRef.current.find((item) => item.id === picker.edgeId)
        : undefined;
      let position = picker.position;
      let shiftFrom: number | null = null;
      if (edge) {
        const source = nodesRef.current.find((node) => node.id === edge.source);
        const target = nodesRef.current.find((node) => node.id === edge.target);
        if (source && target && target.position.x >= source.position.x) {
          if (target.position.x - source.position.x < 520) {
            shiftFrom = target.position.x;
            position = { x: target.position.x, y: target.position.y };
          }
        }
      }
      const nextNodes = [
        ...nodesRef.current.map((node) =>
          shiftFrom !== null && node.position.x >= shiftFrom
            ? { ...node, position: { ...node.position, x: node.position.x + 280 } }
            : node,
        ),
        createNode(id, kind, position),
      ];
      let nextEdges = edgesRef.current;
      if (edge) {
        let before = createEdge(edge.source, id);
        if (edge.label !== undefined) before.label = edge.label;
        const source = nodesRef.current.find((node) => node.id === edge.source);
        if (source?.data.kind === "condition") {
          const branch = branchIdOf(edge) ?? String(edge.label || "default");
          before = configureBranchEdge(before, source.data.config, branch);
        }
        nextEdges = [
          ...nextEdges.filter((item) => item.id !== edge.id),
          before,
          createEdge(id, edge.target),
        ];
      } else if (picker.sourceNodeId && picker.branchId) {
        const source = nodesRef.current.find((node) => node.id === picker.sourceNodeId);
        if (
          !source ||
          kind === "start" ||
          !conditionBranches(source.data.config).some((branch) => branch.id === picker.branchId)
        )
          return;
        nextEdges = [
          ...nextEdges,
          configureBranchEdge(createEdge(source.id, id), source.data.config, picker.branchId),
        ];
      }
      applyGraphEdit(nextNodes, nextEdges);
      setNodePicker(null);
      setSelectedId(id);
      setMobileView("inspector");
    },
    [nodePicker, applyGraphEdit],
  );

  const updateSelected = (patch: Partial<WorkflowNodeData>) => {
    if (!selectedId) return;
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedId ? { ...node, data: { ...node.data, ...patch } } : node,
      ),
    );
    markEdited();
  };

  const updateConfig = (key: string, value: WorkflowConfigValue) => {
    if (!selectedNode) return;
    updateSelected({ config: { ...selectedNode.data.config, [key]: value } });
  };

  const renameBinding = (
    kind: "inputs" | "outputs" | "runVariables",
    index: number,
    name: string,
  ) => {
    if (!selectedNode) return;
    const items = selectedNode.data.config[kind] as Array<{ name: string }>;
    const previous = items[index]?.name;
    const canRename =
      validVariableName(name) && !items.some((item, i) => i !== index && item.name === name);
    if (!canRename) return;
    setNodes((current) => {
      const updated = current.map((node) =>
        node.id === selectedNode.id
          ? {
              ...node,
              data: {
                ...node.data,
                config: {
                  ...node.data.config,
                  [kind]: items.map((item, i) => (i === index ? { ...item, name } : item)),
                },
              },
            }
          : node,
      );
      return previous ? renameVariable(updated, selectedNode.id, kind, previous, name) : updated;
    });
    markEdited();
  };

  const repairReference = (issue: WorkflowValidationIssue, replacement: string) => {
    if (!issue.nodeId || !issue.reference || !issue.suggestions?.includes(replacement)) return;
    const next = repairVariableReference(
      nodesRef.current,
      { ...issue, nodeId: issue.nodeId },
      replacement,
    );
    if (next === nodesRef.current) return;
    commitHistory();
    nodesRef.current = next;
    setNodes(next);
    commitHistory();
    markEdited();
  };

  const changeCondition = (config: Record<string, unknown>) => {
    if (!selectedId) return;
    const next = updateConditionGraph(nodesRef.current, edgesRef.current, selectedId, config);
    applyGraphEdit(next.nodes, next.edges);
  };
  const removeConnection = (edgeId: string) => {
    applyGraphEdit(
      nodesRef.current,
      edgesRef.current.filter((edge) => edge.id !== edgeId),
    );
  };

  const duplicateSelected = useCallback(() => {
    if (running) return;
    const selected = nodesRef.current.filter((node) => node.selected).map((node) => node.id);
    const ids = new Set(selected.length ? selected : selectedId ? [selectedId] : []);
    if (!ids.size) return;
    try {
      const copied = cloneSubgraph(nodesRef.current, edgesRef.current, ids, true);
      applyGraphEdit(
        [...nodesRef.current.map((node) => ({ ...node, selected: false })), ...copied.nodes],
        [...edgesRef.current, ...copied.edges],
      );
      setSelectedId(copied.nodes.length === 1 ? copied.nodes[0]!.id : null);
    } catch (reason) {
      setWorkspaceError(reason instanceof Error ? reason.message : "复制失败");
    }
  }, [applyGraphEdit, running, selectedId]);

  const removeSelected = () => {
    if (running || !selectedIds.length) return;
    setPendingDelete({ nodes: selectedIds, edges: [] });
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const ids = new Set(pendingDelete.nodes);
    const edgeIds = new Set(pendingDelete.edges);
    if (nodeTestPendingId && ids.has(nodeTestPendingId)) {
      nodeTestToken.current += 1;
      nodeTestController.current?.abort();
      setNodeTestPendingId(null);
    }
    applyGraphEdit(
      nodesRef.current.filter((node) => !ids.has(node.id)),
      edgesRef.current.filter(
        (edge) => !ids.has(edge.source) && !ids.has(edge.target) && !edgeIds.has(edge.id),
      ),
    );
    setNodeTestResults((current) => {
      const next = { ...current };
      for (const id of ids) delete next[id];
      return next;
    });
    setSelectedId(null);
    setMobileView("canvas");
    setPendingDelete(null);
  };

  const save = useCallback(() => {
    commitHistory();
    void persistDraft();
  }, [commitHistory, persistDraft]);

  const copySelection = useCallback(async () => {
    const selected = nodesRef.current.filter((node) => node.selected).map((node) => node.id);
    try {
      if (!navigator.clipboard) throw new Error("当前浏览器无法访问剪贴板");
      await navigator.clipboard.writeText(
        serializeSelection(
          nodesRef.current,
          edgesRef.current,
          new Set(selected.length ? selected : selectedId ? [selectedId] : []),
        ),
      );
      setPublishNotice(`已复制 ${selected.length || 1} 个节点`);
    } catch (reason) {
      setWorkspaceError(reason instanceof Error ? reason.message : "复制失败");
    }
  }, [selectedId]);

  const pasteSelection = useCallback(async () => {
    if (running) return;
    try {
      if (!navigator.clipboard) throw new Error("当前浏览器无法访问剪贴板");
      const copied = parseSelection(await navigator.clipboard.readText());
      assertSelectionSources(copied.nodes, nodesRef.current);
      const nextNodes = [
        ...nodesRef.current.map((node) => ({ ...node, selected: false })),
        ...copied.nodes,
      ];
      const nextEdges = [...edgesRef.current, ...copied.edges];
      const issues = validateWorkflowGraph(nextNodes, nextEdges, resources.catalog);
      applyGraphEdit(nextNodes, nextEdges);
      setSelectedId(copied.nodes.length === 1 ? copied.nodes[0]!.id : null);
      setWorkspaceError(
        issues.length
          ? `已粘贴 ${copied.nodes.length} 个节点，但仍有问题：${issues
              .slice(0, 3)
              .map((issue) => issue.message)
              .join("；")}`
          : null,
      );
      setShowIssues(true);
    } catch (reason) {
      setWorkspaceError(reason instanceof Error ? reason.message : "粘贴失败");
    }
  }, [applyGraphEdit, resources.catalog, running]);

  const arrangeGraph = () => {
    if (running) return;
    try {
      applyGraphEdit(layoutWorkflow(nodesRef.current, edgesRef.current), edgesRef.current);
      window.requestAnimationFrame(() => {
        void fitView({ padding: 0.2, duration: 240 });
      });
    } catch (reason) {
      setWorkspaceError(reason instanceof Error ? reason.message : "布局失败");
    }
  };

  const exportGraph = () => {
    try {
      downloadWorkflow(
        snapshotGraph(nameRef.current, nodesRef.current, edgesRef.current),
        workflow?.app.slug ?? "workflow",
      );
      setConfirmExport(false);
    } catch (reason) {
      setConfirmExport(false);
      setWorkspaceError(reason instanceof Error ? reason.message : "导出失败");
    }
  };

  const publish = useCallback(
    async (releaseNotes: string) => {
      if (validationIssues.length > 0) {
        setShowIssues(true);
        return;
      }
      setPublishState("publishing");
      setWorkspaceError(null);
      const revision = await persistDraft();
      if (revision === null) {
        setPublishState("error");
        return;
      }
      try {
        const published = await publishWorkflow(workflowId, revision, releaseNotes.trim());
        setWorkflow(published);
        setPublishState("idle");
        setShowPublish(false);
        const version = published.versions.find(
          (item) => item.id === published.app.currentVersionId,
        );
        setPublishNotice(`已发布 v${version?.versionNumber ?? ""}`);
      } catch (reason) {
        setPublishState("error");
        setWorkspaceError(reason instanceof Error ? reason.message : "工作流发布失败");
      }
    },
    [persistDraft, validationIssues.length, workflowId],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      const command = event.metaKey || event.ctrlKey;
      if (document.querySelector("dialog[open]")) return;
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
        return;
      }
      if (isEditing) return;
      if (command && event.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
        event.preventDefault();
        void copySelection();
      }
      if (command && event.key.toLowerCase() === "v") {
        event.preventDefault();
        void pasteSelection();
      }
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
      if (
        command &&
        event.key.toLowerCase() === "d" &&
        (selectedId || nodesRef.current.some((node) => node.selected))
      ) {
        event.preventDefault();
        duplicateSelected();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copySelection, pasteSelection, duplicateSelected, redo, save, selectedId, undo]);

  const run = () => {
    if (running || nodeTestPendingId) return;
    if (validationIssues.length > 0) {
      setShowIssues(true);
      return;
    }
    const names = runVariables(variableNodes(nodes)).map((variable) => variable.name);
    setRunInputs((current) => Object.fromEntries(names.map((name) => [name, current[name] ?? ""])));
    if (names.length > 0) {
      setShowRunInputs(true);
      return;
    }
    void startRun({});
  };

  const stopRun = useCallback(() => {
    if (!running) return;
    runToken.current += 1;
    runController.current?.abort();
    setRunning(false);
    setEdgeRunStates((current) =>
      Object.fromEntries(Object.entries(current).filter(([, status]) => status !== "active")),
    );
    setRunOutputs(null);
    setFinalOutputs(null);
    setNodes((current) =>
      current.map((node) =>
        node.data.status === "running" ? { ...node, data: { ...node.data, status: "idle" } } : node,
      ),
    );
    setRunLog((current) => [
      ...current,
      { id: `cancelled-${Date.now()}`, label: "Workflow", status: "error", detail: "运行已停止" },
    ]);
  }, [running, setNodes]);

  const executeNodeTest = async (node: WorkflowNode, values: Record<string, string>) => {
    const token = ++nodeTestToken.current;
    nodeTestController.current?.abort();
    const controller = new AbortController();
    nodeTestController.current = controller;
    const inputs = Object.fromEntries(
      nodeInputs(node.data).map((binding) => [
        binding.name,
        parseNodeTestValue(values[binding.name] ?? ""),
      ]),
    );
    const startedAtMs = Date.now();
    setNodeTestDialog(null);
    setNodeTestPendingId(node.id);
    setNodes((current) =>
      current.map((item) => {
        if (item.id === node.id) return { ...item, data: { ...item.data, status: "running" } };
        if (item.id === nodeTestPendingId && item.data.status === "running") {
          return { ...item, data: { ...item.data, status: "idle" } };
        }
        return item;
      }),
    );
    try {
      const result = await testWorkflowNode(
        {
          id: node.id,
          kind: node.data.kind,
          label: node.data.label,
          config: node.data.config,
        },
        inputs,
        controller.signal,
      );
      if (nodeTestToken.current !== token) return;
      setNodeTestResults((current) => ({ ...current, [node.id]: result }));
      setNodes((current) =>
        current.map((item) =>
          item.id === node.id ? { ...item, data: { ...item.data, status: result.status } } : item,
        ),
      );
    } catch (reason) {
      if (nodeTestToken.current !== token || (reason as Error).name === "AbortError") return;
      const finishedAtMs = Date.now();
      const result: WorkflowNodeTestResult = {
        nodeId: node.id,
        status: "error",
        inputs,
        result: null,
        outputs: {},
        error: reason instanceof Error ? reason.message : "节点测试失败",
        metadata: {
          nodeKind: node.data.kind,
          startedAt: new Date(startedAtMs).toISOString(),
          finishedAt: new Date(finishedAtMs).toISOString(),
          durationMs: Math.max(0, finishedAtMs - startedAtMs),
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      };
      setNodeTestResults((current) => ({ ...current, [node.id]: result }));
      setNodes((current) =>
        current.map((item) =>
          item.id === node.id ? { ...item, data: { ...item.data, status: "error" } } : item,
        ),
      );
    } finally {
      if (nodeTestToken.current === token) setNodeTestPendingId(null);
    }
  };

  const beginNodeTest = (node: WorkflowNode) => {
    if (running || nodeTestPendingId) return;
    const values = createNodeTestInputDraft(node.data, runOutputs, runInputs);
    if (nodeInputs(node.data).length === 0) {
      void executeNodeTest(node, values);
      return;
    }
    setNodeTestDialog({ nodeId: node.id, values });
  };

  const nodeTestDialogNode = nodeTestDialog
    ? nodes.find((node) => node.id === nodeTestDialog.nodeId)
    : null;

  const beginResume = (history: WorkflowRunHistory, nodeId: string) => {
    if (running || nodeTestPendingId) return;
    try {
      const checkpoint = prepareResumeCheckpoint(
        {
          nodes: variableNodes(nodesRef.current),
          edges: edgesRef.current.map((edge) => ({
            ...edge,
            label: typeof edge.label === "string" ? edge.label : undefined,
          })),
        },
        {
          nodes: variableNodes(history.graph.nodes),
          edges: history.graph.edges.map((edge) => ({
            ...edge,
            label: typeof edge.label === "string" ? edge.label : undefined,
          })),
        },
        nodeId,
        cachedNodesFromEvents(history.events),
      );
      setPendingResume({ history, checkpoint });
    } catch (reason) {
      setWorkspaceError(reason instanceof Error ? reason.message : "无法续跑");
    }
  };

  const startRun = async (
    input: Record<string, unknown>,
    resume?: { runId: string; fromNodeId: string },
  ) => {
    if (running) return;
    if (validationIssues.length > 0) {
      setShowRunInputs(false);
      setShowIssues(true);
      return;
    }
    const token = ++runToken.current;
    setShowRunInputs(false);
    setInspectorView("current");
    setRunning(true);
    setEdgeRunStates({});
    runIncomingEdges.current = {};
    setRunLog([]);
    setRunOutputs(null);
    setFinalOutputs(null);
    setNodes((current) =>
      current.map((node) => ({ ...node, data: { ...node.data, status: "idle" } })),
    );
    runController.current = streamWorkflow(
      {
        workflowId,
        resume,
        nodes: nodes.map((node) => ({
          id: node.id,
          kind: node.data.kind,
          label: node.data.label,
          config: node.data.config,
        })),
        edges: edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          ...(typeof edge.label === "string" && edge.label ? { label: edge.label } : {}),
          ...(branchIdOf(edge) ? { branchId: branchIdOf(edge) } : {}),
        })),
        input,
      },
      {
        onNodeStart: (nodeId, _label, _kind, incomingEdgeIds) => {
          if (runToken.current !== token) return;
          runIncomingEdges.current[nodeId] = incomingEdgeIds ?? [];
          setEdgeRunStates((current) => updateRunEdges(current, incomingEdgeIds ?? [], "active"));
          focusRunNode(nodeId);
          setNodes((current) =>
            current.map((node) =>
              node.id === nodeId ? { ...node, data: { ...node.data, status: "running" } } : node,
            ),
          );
        },
        onNodeResult: (nodeId, status, meta) => {
          if (runToken.current !== token) return;
          setEdgeRunStates((current) =>
            updateRunEdges(
              current,
              runIncomingEdges.current[nodeId] ?? meta.metadata?.incomingEdgeIds ?? [],
              meta.metadata?.cached ? "done" : status === "success" ? "done" : "error",
            ),
          );
          const node = nodes.find((item) => item.id === nodeId);
          setNodes((current) =>
            current.map((item) =>
              item.id === nodeId ? { ...item, data: { ...item.data, status } } : item,
            ),
          );
          setRunLog((current) => [
            ...current,
            {
              id: nodeId,
              label: node?.data.label ?? nodeId,
              kind: node?.data.kind,
              status,
              ...(meta.error ? { detail: meta.error } : {}),
              inputs: meta.inputs,
              outputs: meta.outputs,
              result: meta.result,
              prompt: meta.prompt,
              systemPrompt: meta.systemPrompt,
              durationMs: meta.metadata?.durationMs,
              attempts: meta.metadata?.attempts,
              cached: meta.metadata?.cached,
              tokenUsage: meta.metadata?.tokenUsage,
              selectedBranchLabel: meta.metadata?.selectedBranchLabel,
              warnings: meta.metadata?.warnings,
            },
          ]);
          if (node?.data.kind === "condition")
            setNodeTestResults((current) => ({
              ...current,
              [nodeId]: {
                nodeId,
                status,
                inputs: meta.inputs ?? {},
                outputs: meta.outputs ?? {},
                result: meta.result,
                error: meta.error,
                metadata: {
                  nodeKind: "condition",
                  startedAt: new Date().toISOString(),
                  finishedAt: new Date().toISOString(),
                  durationMs: meta.metadata?.durationMs ?? 0,
                  tokenUsage: meta.metadata?.tokenUsage ?? {
                    inputTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                  },
                  selectedBranchId: meta.metadata?.selectedBranchId,
                  selectedBranchLabel: meta.metadata?.selectedBranchLabel,
                  warnings: meta.metadata?.warnings,
                },
              },
            }));
        },
        onDone: (outputs, nodeOutputs) => {
          if (runToken.current !== token) return;
          setRunOutputs(nodeOutputs);
          setFinalOutputs(outputs);
          setRunning(false);
          setRunHistoryRevision((revision) => revision + 1);
        },
        onError: (error, nodeId) => {
          if (runToken.current !== token) return;
          if (nodeId) focusRunNode(nodeId);
          setRunOutputs(null);
          setFinalOutputs(null);
          setRunLog((current) => [
            ...current,
            { id: nodeId ?? "run", label: nodeId ?? "Workflow", status: "error", detail: error },
          ]);
          setRunning(false);
          setEdgeRunStates((current) =>
            Object.fromEntries(
              Object.entries(current).map(([id, state]) => [
                id,
                state === "active" ? "error" : state,
              ]),
            ),
          );
          setRunHistoryRevision((revision) => revision + 1);
        },
      },
    );
  };

  if (workspaceLoading && !workflow) {
    return (
      <Flex justify="center" style={{ padding: 64 }}>
        <Spin tip="正在加载工作流..." />
      </Flex>
    );
  }

  if (!workflow) {
    return (
      <Flex vertical gap={12} align="center" style={{ padding: 64 }}>
        <Alert type="error" showIcon message={workspaceError ?? "工作流不存在"} />
        <Button onClick={onBack}>返回工作流列表</Button>
      </Flex>
    );
  }

  const liveVersion = workflow.versions.find(
    (version) => version.id === workflow.app.currentVersionId,
  );

  return (
    <section className="workflow-workspace">
      <header className="workflow-toolbar">
        <div className="workflow-title">
          <Tooltip title="返回工作流列表">
            <Button
              type="text"
              icon={<PanelLeftCloseOutlined />}
              aria-label="返回工作流列表"
              onClick={() => void persistDraft().then((revision) => revision !== null && onBack())}
            />
          </Tooltip>
          <ApartmentMark />
          <div>
            <span>
              工作流编排
              <small className={liveVersion ? "is-live" : undefined}>
                {liveVersion ? `LIVE v${liveVersion.versionNumber}` : "DRAFT"}
              </small>
            </span>
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                markEdited();
              }}
              aria-label="工作流名称"
              suffix={<EditOutlined />}
              style={{ maxWidth: 280 }}
            />
          </div>
        </div>
        <div className="workflow-actions">
          {workspaceError ? (
            <Typography.Text type="danger" title={workspaceError}>
              {workspaceError}
            </Typography.Text>
          ) : null}
          {publishNotice ? (
            <Typography.Text type="secondary" role="status">
              {publishNotice}
            </Typography.Text>
          ) : null}
          <Flex gap={4} aria-label="编辑历史">
            <Tooltip title="撤销">
              <Button type="text" icon={<UndoOutlined />} aria-label="撤销" disabled={!canUndo} onClick={undo} />
            </Tooltip>
            <Tooltip title="重做">
              <Button type="text" icon={<RedoOutlined />} aria-label="重做" disabled={!canRedo} onClick={redo} />
            </Tooltip>
          </Flex>
          <Button icon={<PlusOutlined />} onClick={openNodePicker}>
            添加节点
          </Button>
          <div className="workflow-validation-wrap">
            <Button
              danger={validationIssues.length > 0}
              icon={validationIssues.length > 0 ? <CloseCircleFilled /> : <CheckCircleFilled />}
              aria-expanded={showIssues}
              aria-label={
                validationIssues.length > 0
                  ? `工作流有 ${validationIssues.length} 个问题`
                  : "工作流结构正常"
              }
              onClick={() => setShowIssues((visible) => !visible)}
            >
              {validationIssues.length > 0 ? `${validationIssues.length} 个问题` : "结构正常"}
            </Button>
            {showIssues ? (
              <div
                className="workflow-validation-menu"
                role="dialog"
                aria-label="工作流问题"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <header>
                  <b>运行前检查</b>
                  <span>{validationIssues.length}</span>
                </header>
                {validationIssues.length === 0 ? (
                  <p>节点连接和变量绑定均可运行。</p>
                ) : (
                  <ol>
                    {validationIssues.map((issue, index) => (
                      <li key={`${issue.code}-${issue.nodeId ?? "workflow"}-${index}`}>
                        <Button type="text" size="small" icon={<CloseCircleFilled />} onClick={() => focusIssue(issue)}>
                          {issue.message} · {issue.nodeId ?? "WORKFLOW"}
                        </Button>
                        {issue.reference &&
                          issue.suggestions?.map((suggestion) => (
                            <Button
                              key={suggestion}
                              type="link"
                              size="small"
                              onClick={() => repairReference(issue, suggestion)}
                            >
                              改为 {suggestion}
                            </Button>
                          ))}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ) : null}
          </div>
          <Typography.Text type={saveState === "error" ? "danger" : "secondary"}>
            {saveState === "error" ? "保存失败" : saveState === "saving" || dirty ? "自动保存中" : "已自动保存"}
          </Typography.Text>
          <Button onClick={() => (validationIssues.length ? setConfirmExport(true) : exportGraph())}>
            导出 JSON
          </Button>
          <Button disabled={running} onClick={arrangeGraph}>
            整理布局
          </Button>
          <Flex gap={4} align="center">
            <Tooltip title="复制节点 ⌘C / Ctrl+C">
              <Button size="small" disabled={!selectedIds.length} onClick={() => void copySelection()}>
                复制
              </Button>
            </Tooltip>
            <Tooltip title="粘贴节点 ⌘V / Ctrl+V">
              <Button size="small" disabled={running} onClick={() => void pasteSelection()}>
                粘贴
              </Button>
            </Tooltip>
          </Flex>
          <Button icon={<SaveOutlined />} onClick={save}>
            保存
          </Button>
          <Tooltip title="API 与版本">
            <Button icon={<ApiOutlined />} onClick={() => void persistDraft().then((revision) => revision !== null && onOpenAccess())}>
              访问点
            </Button>
          </Tooltip>
          <Button
            type="primary"
            icon={<RocketOutlined />}
            loading={publishState === "publishing"}
            disabled={running || validationIssues.length > 0}
            onClick={() => {
              setWorkspaceError(null);
              setShowPublish(true);
            }}
          >
            {publishState === "publishing" ? "发布中" : "发布"}
          </Button>
          <Button
            type="primary"
            danger={running}
            icon={running ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
            aria-label={running ? "停止工作流" : "运行工作流"}
            disabled={nodeTestPendingId !== null}
            onClick={() => (running ? stopRun() : void run())}
          >
            {running ? "停止" : "运行"}
          </Button>
        </div>
      </header>

      <Segmented
        aria-label="Workflow 工作区视图"
        value={mobileView}
        onChange={(value) => {
          if (value === "canvas") showCanvas();
          else setMobileView(value as typeof mobileView);
        }}
        options={[
          { value: "palette", label: "节点库", icon: <PlusOutlined /> },
          { value: "canvas", label: "画布", icon: <BranchesOutlined /> },
          { value: "inspector", label: selectedNode ? "配置" : "运行", icon: <ExperimentOutlined /> },
        ]}
        style={{ margin: "8px 12px 0" }}
      />
      {confirmExport ? (
        <ConfirmDialog
          title="导出存在问题的工作流？"
          detail={`当前有 ${validationIssues.length} 个问题，文件可能无法运行。修复后才可重新导入。`}
          confirmLabel="仍然导出"
          onConfirm={exportGraph}
          onCancel={() => setConfirmExport(false)}
        />
      ) : null}

      <div className={`workflow-layout mobile-view-${mobileView}`}>
        <Flex vertical style={{ padding: "0 10px" }}>
          <Flex align="center" justify="space-between" style={{ padding: "12px 4px" }}>
            <Typography.Text strong>节点库</Typography.Text>
            <Badge count={filteredPalette.length} showZero />
          </Flex>
          <Input
            className="palette-search"
            prefix={<SearchOutlined />}
            value={paletteQuery}
            onChange={(event) => setPaletteQuery(event.target.value)}
            placeholder="搜索节点"
            aria-label="搜索节点"
            allowClear
          />
          {(["输入", "知识与模型", "工具与逻辑", "输出"] as const)
            .filter((group) => filteredPalette.some((item) => item.group === group))
            .map((group) => (
              <Flex vertical className="palette-group" key={group}>
                <Typography.Text className="palette-group-label">{group}</Typography.Text>
                {filteredPalette
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <Button
                      htmlType="button"
                      key={item.kind}
                      className={`palette-item kind-${item.kind}`}
                      disabled={
                        item.kind === "start" && nodes.some((node) => node.data.kind === "start")
                      }
                      draggable={
                        item.kind !== "start" || !nodes.some((node) => node.data.kind === "start")
                      }
                      title={
                        item.kind === "start" && nodes.some((node) => node.data.kind === "start")
                          ? "工作流只能有一个开始节点"
                          : item.description
                      }
                      onClick={() => addPaletteNode(item.kind)}
                      onDragStart={(event) => {
                        event.dataTransfer.setData("application/open-agent-node", item.kind);
                        event.dataTransfer.effectAllowed = "move";
                      }}
                    >
                      <Flex className="palette-item-icon">{iconByKind[item.kind]}</Flex>
                      <Flex vertical className="palette-item-copy">
                        <Typography.Text strong>{item.label}</Typography.Text>
                        <Typography.Text type="secondary">{item.description}</Typography.Text>
                      </Flex>
                    </Button>
                  ))}
              </Flex>
            ))}
          {filteredPalette.length === 0 ? (
            <Empty
              className="palette-empty"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="没有匹配的节点"
            />
          ) : null}
        </Flex>

        <div className="flow-canvas" ref={flowCanvasRef}>
          <WorkflowBranchActionsContext.Provider value={openBranchNodePicker}>
            <WorkflowEdgeActionsContext.Provider value={openEdgeNodePicker}>
              <ReactFlow<WorkflowNode, Edge>
                nodes={nodes}
                edges={decorateRunEdges(edges, edgeRunStates)}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={(changes) => {
                  onNodesChange(changes);
                  if (
                    changes.some(
                      (change) =>
                        change.type === "remove" ||
                        (change.type === "position" && change.dragging !== true),
                    )
                  ) {
                    markEdited();
                  }
                }}
                onEdgesChange={(changes) => {
                  onEdgesChange(changes);
                  if (changes.some((change) => change.type !== "select")) markEdited();
                }}
                onConnect={connect}
                isValidConnection={(connection) =>
                  canConnectTarget(
                    connection.source,
                    connection.target,
                    nodesRef.current,
                    edgesRef.current,
                  )
                }
                onDrop={dropNode}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onNodeClick={(_, node) => {
                  setInspectorView("current");
                  setSelectedId(node.id);
                  setMobileView("inspector");
                }}
                onPaneClick={() => {
                  setSelectedId(null);
                  setShowIssues(false);
                }}
                fitView
                fitViewOptions={{
                  padding: 0.2,
                  minZoom: compactLayout ? 0.25 : 0.5,
                  maxZoom: compactLayout ? 0.7 : 1,
                }}
                minZoom={compactLayout ? 0.25 : 0.35}
                maxZoom={2}
                onlyRenderVisibleElements
                selectionOnDrag
                selectionKeyCode={null}
                multiSelectionKeyCode={["Shift", "Meta", "Control"]}
                panOnDrag={true}
                nodesDraggable={!running}
                nodesConnectable={!running}
                onSelectionChange={({ nodes: selected }) => {
                  setSelectedId(selected.length === 1 ? selected[0]!.id : null);
                }}
                onBeforeDelete={async ({ nodes: removedNodes, edges: removedEdges }) => {
                  if (!running)
                    setPendingDelete({
                      nodes: removedNodes.map((node) => node.id),
                      edges: removedEdges.map((edge) => edge.id),
                    });
                  return false;
                }}
                deleteKeyCode={running ? null : ["Backspace", "Delete"]}
                defaultEdgeOptions={{ type: "studio" }}
              >
                <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#c9cdd3" />
                <Controls showInteractive={false} />
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(node) => nodeColor((node.data as WorkflowNodeData).kind)}
                  maskColor="rgba(246, 247, 249, 0.72)"
                />
              </ReactFlow>
            </WorkflowEdgeActionsContext.Provider>
          </WorkflowBranchActionsContext.Provider>
          {selectedNodes.length > 1 ? (
            <Flex gap={8} align="center" role="toolbar" aria-label="批量操作" style={{ padding: 8 }}>
              <Tag>已选 {selectedNodes.length} 个节点</Tag>
              <Button size="small" disabled={running} onClick={duplicateSelected}>
                复制
              </Button>
              <Button size="small" danger disabled={running} onClick={removeSelected}>
                删除
              </Button>
              <Button
                size="small"
                type="text"
                onClick={() => {
                  setNodes((current) => current.map((node) => ({ ...node, selected: false })));
                  setSelectedId(null);
                }}
              >
                取消选择
              </Button>
            </Flex>
          ) : null}
          <div className="workflow-canvas-status">
            <span>
              <ThunderboltOutlined /> 编排画布
            </span>
            <code>
              {nodes.length} NODES · {edges.length} EDGES
            </code>
          </div>
        </div>

        <Flex vertical className="workflow-inspector" style={{ padding: 0 }}>
          <Flex align="center" justify="space-between" style={{ padding: "12px 14px" }}>
            <Typography.Text strong>
              {inspectorView === "history" ? "运行历史" : selectedNode ? "节点配置" : "运行预览"}
            </Typography.Text>
            {selectedNode && inspectorView === "current" ? (
              <Flex className="inspector-heading-actions">
                <Button
                  type="text"
                  title="复制节点"
                  aria-label="复制节点"
                  icon={<CopyOutlined />}
                  onClick={duplicateSelected}
                />
                <Button
                  type="text"
                  danger
                  title="删除节点"
                  aria-label="删除节点"
                  icon={<DeleteOutlined />}
                  onClick={removeSelected}
                />
              </Flex>
            ) : null}
          </Flex>
          <Segmented
            className="workflow-panel-switcher"
            aria-label="编辑器检查面板"
            block
            value={inspectorView}
            options={[
              { value: "current", label: selectedNode ? "节点配置" : "本次运行" },
              { value: "history", label: "运行历史" },
            ]}
            onChange={setInspectorView}
          />
          {inspectorView === "history" ? (
            <RunHistoryPanel
              key={workflowId}
              workflowId={workflowId}
              refreshKey={runHistoryRevision}
              currentGraph={snapshotGraph(name, nodes, edges)}
              resumeDisabled={running || nodeTestPendingId !== null || validationIssues.length > 0}
              onResume={beginResume}
            />
          ) : selectedNode ? (
            <NodeInspector
              key={selectedNode.id}
              node={selectedNode}
              nodes={nodes}
              edges={edges}
              providers={providers}
              providerError={providerError}
              onConditionChange={changeCondition}
              onAddBranch={(branchId, anchor) =>
                openBranchNodePicker(selectedNode.id, branchId, anchor)
              }
              onRemoveConnection={removeConnection}
              onFocusNode={(nodeId) => {
                setSelectedId(nodeId);
                focusRunNode(nodeId);
              }}
              updateNode={updateSelected}
              updateConfig={updateConfig}
              renameVariable={renameBinding}
              onRepairReference={repairReference}
              onManageVariables={() => {
                const start = nodes.find((node) => node.data.kind === "start");
                if (start) setSelectedId(start.id);
              }}
              catalog={resources.catalog}
              loading={resources.loading}
              resourceError={resources.error}
              refreshResources={() => void resources.refresh()}
              testResult={nodeTestResults[selectedNode.id]}
              testPending={nodeTestPendingId === selectedNode.id}
              testDisabled={running || nodeTestPendingId !== null}
              onTest={() => beginNodeTest(selectedNode)}
            />
          ) : (
            <RunPreview
              nodes={nodes}
              edges={edges}
              running={running}
              runDisabled={nodeTestPendingId !== null}
              log={runLog}
              outputs={finalOutputs}
              onRun={() => void run()}
              onStop={stopRun}
            />
          )}
        </Flex>
      </div>
      {pendingDelete ? (
        <ConfirmDialog
          title="删除选中内容？"
          detail={`将删除 ${pendingDelete.nodes.length} 个节点及关联连接。这次操作可整体撤销。`}
          confirmLabel="确认删除"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
      {pendingResume ? (
        <ResumeDialog
          checkpoint={pendingResume.checkpoint}
          onCancel={() => setPendingResume(null)}
          onRun={() => {
            const { history, checkpoint } = pendingResume;
            setPendingResume(null);
            setSelectedId(null);
            setNodes((current) => current.map((node) => ({ ...node, selected: false })));
            void startRun(history.run.inputs, {
              runId: history.run.id,
              fromNodeId: checkpoint.fromNodeId,
            });
          }}
        />
      ) : null}
      {showPublish ? (
        <PublishDialog
          pending={publishState === "publishing"}
          error={workspaceError}
          onCancel={() => setShowPublish(false)}
          onPublish={(notes) => void publish(notes)}
        />
      ) : null}
      {nodePicker
        ? createPortal(
            <NodePicker
              state={nodePicker}
              hasStart={nodes.some((node) => node.data.kind === "start")}
              onChoose={chooseNode}
              onClose={() => setNodePicker(null)}
              existingNodes={
                nodePicker.sourceNodeId
                  ? nodes
                      .filter((node) =>
                        canConnectTarget(nodePicker.sourceNodeId!, node.id, nodes, edges),
                      )
                      .map((node) => ({
                        id: node.id,
                        label: node.data.label,
                        kind: node.data.kind,
                      }))
                  : []
              }
              onChooseExisting={chooseExistingNode}
            />,
            document.body,
          )
        : null}
      {showRunInputs
        ? createPortal(
            <RunInputDialog
              variables={runVariables(variableNodes(nodes))}
              values={runInputs}
              setValues={setRunInputs}
              onCancel={() => setShowRunInputs(false)}
              onRun={(input) => void startRun(input)}
            />,
            document.body,
          )
        : null}
      {nodeTestDialog && nodeTestDialogNode
        ? createPortal(
            <NodeTestInputDialog
              node={nodeTestDialogNode}
              values={nodeTestDialog.values}
              setValues={(values) => setNodeTestDialog({ ...nodeTestDialog, values })}
              onCancel={() => setNodeTestDialog(null)}
              onRun={() => {
                const node = nodes.find((item) => item.id === nodeTestDialog.nodeId);
                if (node) void executeNodeTest(node, nodeTestDialog.values);
              }}
            />,
            document.body,
          )
        : null}
    </section>
  );
}

function ApartmentMark() {
  return (
    <span className="workflow-mark">
      <BranchesOutlined />
    </span>
  );
}
