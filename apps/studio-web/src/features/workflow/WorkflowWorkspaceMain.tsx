import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
  PlayCircleOutlined,
  PlusOutlined,
  RedoOutlined,
  SaveOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from "../../lib/icons.js";
import { useResourceCatalog } from "../../features/resources/useResourceCatalog.js";
import { fetchProviders, type ProviderMetadata } from "../../features/providers/api.js";
import {
  streamWorkflow,
  testWorkflowNode,
  type WorkflowNodeTestResult,
} from "../../lib/api.js";
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
  initialEdges,
  initialNodes,
  loadSavedGraph,
  snapshotGraph,
  snapshotKey,
  storageKey,
} from "./graph.js";
import { iconByKind, nodeColor, palette } from "./palette.js";
import { StudioNode } from "./StudioNode.js";
import { StudioEdge, WorkflowEdgeActionsContext } from "./StudioEdge.js";
import { NodePicker } from "./NodePicker.js";
import { NodeInspector } from "./NodeInspector.js";
import { RunPreview } from "./RunPreview.js";
import { RunInputDialog } from "./RunInputDialog.js";
import { NodeTestInputDialog } from "./NodeTestInputDialog.js";
import type { NodePickerState, RunLogEntry, WorkflowNode, WorkflowSnapshot } from "./types.js";

interface NodeTestDialogState {
  nodeId: string;
  values: Record<string, string>;
}

type WorkflowMobileView = "palette" | "canvas" | "inspector";

const nodeTypes = { studio: StudioNode };
const edgeTypes = { studio: StudioEdge };

export function WorkflowWorkspace() {
  return (
    <ReactFlowProvider>
      <WorkflowCanvas />
    </ReactFlowProvider>
  );
}

function WorkflowCanvas() {
  const resources = useResourceCatalog();
  const [providers, setProviders] = useState<ProviderMetadata[]>([]);
  const [providerError, setProviderError] = useState<string | null>(null);
  const saved = useMemo(loadSavedGraph, []);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNode>(
    saved?.nodes ?? initialNodes,
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(saved?.edges ?? initialEdges);
  const [name, setName] = useState(saved?.name ?? "知识库问答工作流");
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
  const [runLog, setRunLog] = useState<RunLogEntry[]>([]);
  const [runOutputs, setRunOutputs] = useState<Record<string, Record<string, unknown>> | null>(
    null,
  );
  const [runInputNames, setRunInputNames] = useState<string[]>([]);
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
      const snapshot = historyRef.current[index];
      if (!snapshot) return;
      historyIndexRef.current = index;
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

  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify(snapshotGraph(nameRef.current, nodesRef.current, edgesRef.current)),
        );
        setDirty(false);
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [dirty, editRevision, historyRevision]);

  const selectedNode = nodes.find((node) => node.id === selectedId) ?? null;

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
      if (!connection.source || !connection.target || connection.source === connection.target)
        return;
      setEdges((current) => addEdge(createEdge(connection.source!, connection.target!), current));
      markEdited();
    },
    [markEdited, setEdges],
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
      setNodes((current) => [
        ...current.map((node) =>
          shiftFrom !== null && node.position.x >= shiftFrom
            ? { ...node, position: { ...node.position, x: node.position.x + 280 } }
            : node,
        ),
        createNode(id, kind, position),
      ]);
      if (edge) {
        setEdges((current) => {
          const before = createEdge(edge.source, id);
          if (edge.label !== undefined) before.label = edge.label;
          return [
            ...current.filter((item) => item.id !== edge.id),
            before,
            createEdge(id, edge.target),
          ];
        });
      }
      setNodePicker(null);
      setSelectedId(id);
      setMobileView("inspector");
      markEdited();
    },
    [markEdited, nodePicker, setEdges, setNodes],
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

  const updateEdgeLabel = (edgeId: string, label: string) => {
    setEdges((current) =>
      current.map((edge) => (edge.id === edgeId ? { ...edge, label: label || undefined } : edge)),
    );
    markEdited();
  };

  const duplicateSelected = useCallback(() => {
    if (!selectedNode) return;
    const id = `${selectedNode.data.kind}-${Date.now()}`;
    const duplicate: WorkflowNode = {
      ...selectedNode,
      id,
      selected: false,
      position: { x: selectedNode.position.x + 36, y: selectedNode.position.y + 36 },
      data: {
        ...selectedNode.data,
        id,
        label: `${selectedNode.data.label} 副本`,
        status: "idle",
        config: JSON.parse(JSON.stringify(selectedNode.data.config)) as Record<
          string,
          WorkflowConfigValue
        >,
      },
    };
    setNodes((current) => [...current, duplicate]);
    setSelectedId(id);
    markEdited();
  }, [markEdited, selectedNode, setNodes]);

  const removeSelected = () => {
    if (!selectedId) return;
    if (nodeTestPendingId === selectedId) {
      nodeTestToken.current += 1;
      nodeTestController.current?.abort();
      setNodeTestPendingId(null);
    }
    setNodes((current) => current.filter((node) => node.id !== selectedId));
    setEdges((current) =>
      current.filter((edge) => edge.source !== selectedId && edge.target !== selectedId),
    );
    setNodeTestResults((current) => {
      const next = { ...current };
      delete next[selectedId];
      return next;
    });
    setSelectedId(null);
    setMobileView("canvas");
    markEdited();
  };

  const save = useCallback(() => {
    commitHistory();
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify(snapshotGraph(nameRef.current, nodesRef.current, edgesRef.current)),
      );
      setDirty(false);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }, [commitHistory]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
        return;
      }
      if (isEditing) return;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
      if (command && event.key.toLowerCase() === "d" && selectedId) {
        event.preventDefault();
        duplicateSelected();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [duplicateSelected, redo, save, selectedId, undo]);

  const run = () => {
    if (running || nodeTestPendingId) return;
    if (validationIssues.length > 0) {
      setShowIssues(true);
      return;
    }
    const names = [
      ...new Set(
        nodes.flatMap((node) =>
          nodeInputs(node.data).flatMap((input) =>
            input.source.type === "run" ? [input.source.variable] : [],
          ),
        ),
      ),
    ];
    setRunInputNames(names);
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
    setRunOutputs(null);
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

  const startRun = async (input: Record<string, unknown>) => {
    if (running) return;
    if (validationIssues.length > 0) {
      setShowRunInputs(false);
      setShowIssues(true);
      return;
    }
    const token = ++runToken.current;
    setShowRunInputs(false);
    setRunning(true);
    setRunLog([]);
    setRunOutputs(null);
    setNodes((current) =>
      current.map((node) => ({ ...node, data: { ...node.data, status: "idle" } })),
    );
    runController.current = streamWorkflow(
      {
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
        })),
        input,
      },
      {
        onNodeStart: (nodeId) => {
          if (runToken.current !== token) return;
          focusRunNode(nodeId);
          setNodes((current) =>
            current.map((node) =>
              node.id === nodeId ? { ...node, data: { ...node.data, status: "running" } } : node,
            ),
          );
        },
        onNodeResult: (nodeId, status, meta) => {
          if (runToken.current !== token) return;
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
              tokenUsage: meta.metadata?.tokenUsage,
            },
          ]);
        },
        onDone: (outputs) => {
          if (runToken.current !== token) return;
          setRunOutputs(outputs);
          setRunning(false);
        },
        onError: (error, nodeId) => {
          if (runToken.current !== token) return;
          if (nodeId) focusRunNode(nodeId);
          setRunOutputs(null);
          setRunLog((current) => [
            ...current,
            { id: nodeId ?? "run", label: nodeId ?? "Workflow", status: "error", detail: error },
          ]);
          setRunning(false);
        },
      },
    );
  };

  return (
    <section className="workflow-workspace">
      <header className="workflow-toolbar">
        <div className="workflow-title">
          <ApartmentMark />
          <div>
            <span>工作流编排</span>
            <label>
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  markEdited();
                }}
                aria-label="工作流名称"
              />
              <EditOutlined />
            </label>
          </div>
        </div>
        <div className="workflow-actions">
          <div className="workflow-history-actions" aria-label="编辑历史">
            <button type="button" title="撤销" aria-label="撤销" disabled={!canUndo} onClick={undo}>
              <UndoOutlined />
            </button>
            <button type="button" title="重做" aria-label="重做" disabled={!canRedo} onClick={redo}>
              <RedoOutlined />
            </button>
          </div>
          <button
            className="studio-button secondary add-node"
            type="button"
            onClick={openNodePicker}
          >
            <PlusOutlined /> <span>添加节点</span>
          </button>
          <div className="workflow-validation-wrap">
            <button
              className={`workflow-validation${validationIssues.length > 0 ? " has-issues" : " is-valid"}`}
              type="button"
              aria-expanded={showIssues}
              aria-label={
                validationIssues.length > 0
                  ? `工作流有 ${validationIssues.length} 个问题`
                  : "工作流结构正常"
              }
              onClick={() => setShowIssues((visible) => !visible)}
            >
              {validationIssues.length > 0 ? <CloseCircleFilled /> : <CheckCircleFilled />}
              <span>
                {validationIssues.length > 0 ? `${validationIssues.length} 个问题` : "结构正常"}
              </span>
            </button>
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
                        <button type="button" onClick={() => focusIssue(issue)}>
                          <CloseCircleFilled />
                          <span>
                            <b>{issue.message}</b>
                            <small>{issue.nodeId ?? "WORKFLOW"}</small>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ) : null}
          </div>
          <span className={`save-state is-${saveState}`}>
            {saveState === "error"
              ? "保存失败"
              : saveState === "saving" || dirty
                ? "自动保存中"
                : "已自动保存"}
          </span>
          <button className="studio-button secondary save-button" type="button" onClick={save}>
            <SaveOutlined /> <span>保存</span>
          </button>
          <button
            className={`studio-button run${running ? " is-stop" : ""}`}
            type="button"
            aria-label={running ? "停止工作流" : "运行工作流"}
            disabled={nodeTestPendingId !== null}
            onClick={() => (running ? stopRun() : void run())}
          >
            {running ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
            <span>{running ? "停止" : "运行"}</span>
          </button>
        </div>
      </header>

      <div className="workflow-mobile-switcher" role="tablist" aria-label="Workflow 工作区视图">
        <button
          type="button"
          role="tab"
          aria-selected={mobileView === "palette"}
          className={mobileView === "palette" ? "is-active" : undefined}
          onClick={() => setMobileView("palette")}
        >
          <PlusOutlined />
          <span>节点库</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobileView === "canvas"}
          className={mobileView === "canvas" ? "is-active" : undefined}
          onClick={showCanvas}
        >
          <BranchesOutlined />
          <span>画布</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobileView === "inspector"}
          className={mobileView === "inspector" ? "is-active" : undefined}
          onClick={() => setMobileView("inspector")}
        >
          <ExperimentOutlined />
          <span>{selectedNode ? "配置" : "运行"}</span>
        </button>
      </div>

      <div className={`workflow-layout mobile-view-${mobileView}`}>
        <aside className="node-palette">
          <div className="panel-heading">
            <span>节点库</span>
            <span className="count-badge">{filteredPalette.length}</span>
          </div>
          <label className="palette-search">
            <SearchOutlined />
            <input
              value={paletteQuery}
              onChange={(event) => setPaletteQuery(event.target.value)}
              placeholder="搜索节点"
              aria-label="搜索节点"
            />
          </label>
          {(["输入", "知识与模型", "工具与逻辑", "输出"] as const).map((group) => (
            <div
              className="palette-group"
              key={group}
              hidden={filteredPalette.every((item) => item.group !== group)}
            >
              <p>{group}</p>
              {filteredPalette
                .filter((item) => item.group === group)
                .map((item) => (
                  <button
                    type="button"
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
                    <span>{iconByKind[item.kind]}</span>
                    <span>
                      <b>{item.label}</b>
                      <small>{item.description}</small>
                    </span>
                  </button>
                ))}
            </div>
          ))}
          {filteredPalette.length === 0 ? (
            <div className="palette-empty">没有匹配的节点</div>
          ) : null}
        </aside>

        <div className="flow-canvas" ref={flowCanvasRef}>
          <WorkflowEdgeActionsContext.Provider value={openEdgeNodePicker}>
            <ReactFlow<WorkflowNode, Edge>
              nodes={nodes}
              edges={edges}
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
              onDrop={dropNode}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onNodeClick={(_, node) => {
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
              deleteKeyCode={["Backspace", "Delete"]}
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
          <div className="workflow-canvas-status">
            <span>
              <ThunderboltOutlined /> 编排画布
            </span>
            <code>
              {nodes.length} NODES · {edges.length} EDGES
            </code>
          </div>
        </div>

        <aside className="workflow-inspector inspector-panel">
          <div className="panel-heading">
            <span>{selectedNode ? "节点配置" : "运行预览"}</span>
            {selectedNode ? (
              <span className="inspector-heading-actions">
                <button
                  type="button"
                  title="复制节点"
                  aria-label="复制节点"
                  onClick={duplicateSelected}
                >
                  <CopyOutlined />
                </button>
                <button
                  type="button"
                  title="删除节点"
                  aria-label="删除节点"
                  onClick={removeSelected}
                >
                  <DeleteOutlined />
                </button>
              </span>
            ) : null}
          </div>
          {selectedNode ? (
            <NodeInspector
              node={selectedNode}
              nodes={nodes}
              edges={edges}
              providers={providers}
              providerError={providerError}
              updateEdgeLabel={updateEdgeLabel}
              updateNode={updateSelected}
              updateConfig={updateConfig}
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
              outputs={runOutputs}
              onRun={() => void run()}
              onStop={stopRun}
            />
          )}
        </aside>
      </div>
      {nodePicker
        ? createPortal(
            <NodePicker
              state={nodePicker}
              hasStart={nodes.some((node) => node.data.kind === "start")}
              onChoose={chooseNode}
              onClose={() => setNodePicker(null)}
            />,
            document.body,
          )
        : null}
      {showRunInputs
        ? createPortal(
            <RunInputDialog
              names={runInputNames}
              values={runInputs}
              setValues={setRunInputs}
              onCancel={() => setShowRunInputs(false)}
              onRun={() => void startRun(runInputs)}
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
