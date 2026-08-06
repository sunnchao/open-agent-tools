import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiOutlined,
  BranchesOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  FlagOutlined,
  PlayCircleFilled,
  PlayCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  PlusOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useResourceCatalog } from "../resources/useResourceCatalog.js";
import type { ResourceCatalog } from "../resources/api.js";
import { fetchProviders, type ProviderMetadata } from "../providers/api.js";
import { streamWorkflow, testWorkflowNode, type WorkflowNodeTestResult } from "../../lib/api.js";
import { formatWorkflowRunOutput } from "./runOutput.js";
import {
  createNodeTestInputDraft,
  describeNodeTestInputSource,
  parseNodeTestValue,
} from "./nodeTest.js";
import {
  defaultConfig,
  migrateNodeData,
  nodeInputs,
  nodeOutputs,
  type NodeInputBinding,
  type NodeOutputBinding,
  validateNodeResources,
  type NodeKind,
  type NodeRunStatus,
  type WorkflowConfigValue,
  type WorkflowNodeData,
} from "./model.js";

type WorkflowNode = Node<WorkflowNodeData, "studio">;

interface NodeTestDialogState {
  nodeId: string;
  values: Record<string, string>;
}

interface PaletteItem {
  kind: NodeKind;
  label: string;
  description: string;
  group: "输入" | "知识与模型" | "工具与逻辑" | "输出";
}

const palette: PaletteItem[] = [
  { kind: "start", label: "开始", description: "工作流入口", group: "输入" },
  { kind: "input", label: "用户输入", description: "定义输入变量", group: "输入" },
  { kind: "rag", label: "知识检索", description: "召回知识片段", group: "知识与模型" },
  { kind: "llm", label: "LLM", description: "生成或理解文本", group: "知识与模型" },
  { kind: "mcp", label: "MCP Tool", description: "调用 MCP 工具", group: "工具与逻辑" },
  { kind: "condition", label: "条件分支", description: "按表达式分流", group: "工具与逻辑" },
  { kind: "end", label: "结束", description: "定义最终输出", group: "输出" },
];

const iconByKind: Record<NodeKind, React.ReactNode> = {
  start: <PlayCircleFilled />,
  input: <UserOutlined />,
  rag: <DatabaseOutlined />,
  llm: <ExperimentOutlined />,
  mcp: <ApiOutlined />,
  condition: <BranchesOutlined />,
  end: <FlagOutlined />,
};

const initialNodes: WorkflowNode[] = [
  createNode("start-1", "start", { x: 100, y: 260 }),
  createNode("rag-1", "rag", { x: 390, y: 180 }),
  createNode("llm-1", "llm", { x: 680, y: 260 }),
  createNode("end-1", "end", { x: 970, y: 260 }),
];

const initialEdges: Edge[] = [
  createEdge("start-1", "rag-1"),
  createEdge("rag-1", "llm-1"),
  createEdge("llm-1", "end-1"),
];

const nodeTypes = { studio: StudioNode };
const storageKey = "open-agent-tools.workflow.v1";

function createNode(id: string, kind: NodeKind, position: { x: number; y: number }): WorkflowNode {
  const definition = palette.find((item) => item.kind === kind)!;
  return {
    id,
    type: "studio",
    position,
    data: {
      kind,
      label: definition.label,
      description: definition.description,
      status: "idle",
      config: defaultConfig(kind),
    },
  };
}

function createEdge(source: string, target: string): Edge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
  };
}

function loadSavedGraph(): { name: string; nodes: WorkflowNode[]; edges: Edge[] } | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { name: string; nodes: WorkflowNode[]; edges: Edge[] };
    return {
      ...saved,
      nodes: saved.nodes.map((node) => ({ ...node, data: migrateNodeData(node.data) })),
    };
  } catch {
    return null;
  }
}

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
  const [dirty, setDirty] = useState(false);
  const [running, setRunning] = useState(false);
  const [runLog, setRunLog] = useState<
    Array<{ id: string; label: string; status: "success" | "error"; detail?: string }>
  >([]);
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
  const { screenToFlowPosition } = useReactFlow();

  useEffect(
    () => () => {
      runToken.current += 1;
      runController.current?.abort();
      nodeTestToken.current += 1;
      nodeTestController.current?.abort();
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
    console.group("workflow");
    console.log("name", name);
    console.log("edges", edges);
    console.groupEnd();
  }, [nodes, edges]);

  const selectedNode = nodes.find((node) => node.id === selectedId) ?? null;

  const connect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target)
        return;
      setEdges((current) => addEdge(createEdge(connection.source!, connection.target!), current));
      setDirty(true);
    },
    [setEdges],
  );

  const dropNode = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData("application/open-agent-node") as NodeKind;
      if (!palette.some((item) => item.kind === kind)) return;
      const id = `${kind}-${Date.now()}`;
      setNodes((current) => [
        ...current,
        createNode(id, kind, screenToFlowPosition({ x: event.clientX, y: event.clientY })),
      ]);
      setSelectedId(id);
      setDirty(true);
    },
    [screenToFlowPosition, setNodes],
  );

  const updateSelected = (patch: Partial<WorkflowNodeData>) => {
    if (!selectedId) return;
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedId ? { ...node, data: { ...node.data, ...patch } } : node,
      ),
    );
    setDirty(true);
  };

  const updateConfig = (key: string, value: WorkflowConfigValue) => {
    if (!selectedNode) return;
    updateSelected({ config: { ...selectedNode.data.config, [key]: value } });
  };

  const updateEdgeLabel = (edgeId: string, label: string) => {
    setEdges((current) =>
      current.map((edge) => (edge.id === edgeId ? { ...edge, label: label || undefined } : edge)),
    );
    setDirty(true);
  };

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
    setDirty(true);
  };

  const save = () => {
    localStorage.setItem(storageKey, JSON.stringify({ name, nodes, edges }));
    setDirty(false);
  };

  const run = () => {
    if (running || nodeTestPendingId) return;
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
    const token = ++runToken.current;
    setShowRunInputs(false);
    setRunning(true);
    setRunLog([]);
    setRunOutputs(null);
    setNodes((current) =>
      current.map((node) => ({ ...node, data: { ...node.data, status: "idle" } })),
    );
    const invalid = nodes
      .map((node) => ({ node, error: validateNodeResources(node.data, resources.catalog) }))
      .find((item) => item.error);
    if (invalid?.error) {
      setRunLog([
        {
          id: invalid.node.id,
          label: invalid.node.data.label,
          status: "error",
          detail: invalid.error,
        },
      ]);
      setNodes((current) =>
        current.map((node) =>
          node.id === invalid.node.id ? { ...node, data: { ...node.data, status: "error" } } : node,
        ),
      );
      setRunning(false);
      return;
    }
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
          setNodes((current) =>
            current.map((node) =>
              node.id === nodeId ? { ...node, data: { ...node.data, status: "running" } } : node,
            ),
          );
        },
        onNodeResult: (nodeId, status, _outputs, error) => {
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
              status,
              ...(error ? { detail: error } : {}),
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
                  setDirty(true);
                }}
                aria-label="工作流名称"
              />
              <EditOutlined />
            </label>
          </div>
        </div>
        <div className="workflow-actions">
          <span className={`save-state${dirty ? " is-dirty" : ""}`}>
            {dirty ? "有未保存更改" : "已保存到本地"}
          </span>
          <button className="studio-button secondary" type="button" onClick={save}>
            <SaveOutlined /> 保存
          </button>
          <button
            className="studio-button run"
            type="button"
            disabled={running || nodeTestPendingId !== null}
            onClick={() => void run()}
          >
            <PlayCircleOutlined /> {running ? "运行中" : "运行"}
          </button>
        </div>
      </header>

      <div className="workflow-layout">
        <aside className="node-palette">
          <div className="panel-heading">节点</div>
          {(["输入", "知识与模型", "工具与逻辑", "输出"] as const).map((group) => (
            <div className="palette-group" key={group}>
              <p>{group}</p>
              {palette
                .filter((item) => item.group === group)
                .map((item) => (
                  <button
                    type="button"
                    key={item.kind}
                    className={`palette-item kind-${item.kind}`}
                    draggable
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
        </aside>

        <div className="flow-canvas">
          <ReactFlow<WorkflowNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) => {
              onNodesChange(changes);
              if (changes.some((change) => change.type !== "select")) setDirty(true);
            }}
            onEdgesChange={(changes) => {
              onEdgesChange(changes);
              setDirty(true);
            }}
            onConnect={connect}
            onDrop={dropNode}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            minZoom={1}
            maxZoom={1.6}
            deleteKeyCode={["Backspace", "Delete"]}
            defaultEdgeOptions={{ type: "smoothstep" }}
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
          <div className="canvas-hint">
            <ThunderboltOutlined /> 拖入节点并连接端口
          </div>
        </div>

        <aside className="workflow-inspector inspector-panel">
          <div className="panel-heading">
            <span>{selectedNode ? "节点配置" : "运行预览"}</span>
            {selectedNode ? (
              <button type="button" title="删除节点" aria-label="删除节点" onClick={removeSelected}>
                <DeleteOutlined />
              </button>
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
            />
          )}
        </aside>
      </div>
      {showRunInputs ? (
        <RunInputDialog
          names={runInputNames}
          values={runInputs}
          setValues={setRunInputs}
          onCancel={() => setShowRunInputs(false)}
          onRun={() => void startRun(runInputs)}
        />
      ) : null}
      {nodeTestDialog && nodeTestDialogNode ? (
        <NodeTestInputDialog
          node={nodeTestDialogNode}
          values={nodeTestDialog.values}
          setValues={(values) => setNodeTestDialog({ ...nodeTestDialog, values })}
          onCancel={() => setNodeTestDialog(null)}
          onRun={() => {
            const node = nodes.find((item) => item.id === nodeTestDialog.nodeId);
            if (node) void executeNodeTest(node, nodeTestDialog.values);
          }}
        />
      ) : null}
    </section>
  );
}

function StudioNode({ data, selected }: NodeProps<WorkflowNode>) {
  return (
    <div
      className={`workflow-node kind-${data.kind} status-${data.status}${selected ? " is-selected" : ""}`}
    >
      {data.kind !== "start" ? <Handle type="target" position={Position.Left} /> : null}
      <header>
        <span className="node-icon">{iconByKind[data.kind]}</span>
        <span className="node-copy">
          <b>{data.label}</b>
          <small>{data.description}</small>
        </span>
        <NodeStatus status={data.status} />
      </header>
      <div className="node-summary">{nodeSummary(data)}</div>
      {data.kind !== "end" ? <Handle type="source" position={Position.Right} /> : null}
    </div>
  );
}

function NodeStatus({ status }: { status: NodeRunStatus }) {
  if (status === "running") return <span className="node-running" />;
  if (status === "success") return <CheckCircleFilled className="node-success" />;
  if (status === "error") return <CloseCircleFilled className="node-error" />;
  return <span className="node-menu">•••</span>;
}

function nodeSummary(data: WorkflowNodeData): string {
  if (data.kind === "rag") {
    const sources = Array.isArray(data.config.sources) ? data.config.sources : [];
    return sources.length > 0
      ? `${sources.length} 个文档 · Top-${data.config.topK}`
      : "选择 RAG 文档";
  }
  if (data.kind === "llm") return String(data.config.model);
  if (data.kind === "mcp")
    return data.config.toolName
      ? `${data.config.serviceSlug} / ${data.config.toolName}`
      : "选择 MCP Tool";
  if (data.kind === "condition") return String(data.config.expression);
  if (data.kind === "input")
    return `输入 ${nodeInputs(data).length} · 输出 ${nodeOutputs(data).length}`;
  if (data.kind === "end") return `输出 ${nodeOutputs(data).length}`;
  return "点击运行开始执行";
}

function NodeInspector({
  node,
  nodes,
  edges,
  providers,
  providerError,
  updateEdgeLabel,
  updateNode,
  updateConfig,
  catalog,
  loading,
  resourceError,
  refreshResources,
  testResult,
  testPending,
  testDisabled,
  onTest,
}: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  edges: Edge[];
  providers: ProviderMetadata[];
  providerError: string | null;
  updateEdgeLabel: (edgeId: string, label: string) => void;
  updateNode: (patch: Partial<WorkflowNodeData>) => void;
  updateConfig: (key: string, value: WorkflowConfigValue) => void;
  catalog: ResourceCatalog | null;
  loading: boolean;
  resourceError: string | null;
  refreshResources: () => void;
  testResult?: WorkflowNodeTestResult;
  testPending: boolean;
  testDisabled: boolean;
  onTest: () => void;
}) {
  const { data } = node;
  const [activeView, setActiveView] = useState<"config" | "run">("config");
  useEffect(() => setActiveView("config"), [node.id]);
  useEffect(() => {
    if (testResult) setActiveView("run");
  }, [testResult]);
  const ragSources = Array.isArray(data.config.sources) ? data.config.sources : [];
  const selectedService = catalog?.mcp.services.find(
    (service) => service.serviceSlug === String(data.config.serviceSlug),
  );
  const selectedTool = selectedService?.tools.find(
    (tool) => tool.name === String(data.config.toolName),
  );
  const availableRagSources = new Set(catalog?.rag.sources.map((source) => source.source) ?? []);
  const missingRagSources = ragSources.filter((source) => !availableRagSources.has(source));
  return (
    <div className="inspector-content node-inspector-content">
      <div className="inspector-title-row">
        <span className={`node-icon kind-${data.kind}`}>{iconByKind[data.kind]}</span>
        <div className="inspector-title-copy">
          <h2>{data.label}</h2>
          <p>{palette.find((item) => item.kind === data.kind)?.group}</p>
        </div>
        <button
          className="node-test-command"
          type="button"
          disabled={testDisabled}
          title="单独测试当前节点"
          onClick={onTest}
        >
          <PlayCircleOutlined /> {testPending ? "测试中" : "测试运行"}
        </button>
      </div>
      <div className="node-inspector-tabs" role="tablist" aria-label="节点检查器视图">
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "config"}
          className={activeView === "config" ? "is-active" : undefined}
          onClick={() => setActiveView("config")}
        >
          配置
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "run"}
          className={activeView === "run" ? "is-active" : undefined}
          onClick={() => setActiveView("run")}
        >
          上次运行
          {testResult ? (
            <span className={`test-tab-dot is-${testResult.status}`} aria-hidden="true" />
          ) : null}
        </button>
      </div>
      {activeView === "run" ? (
        <NodeTestResultPanel
          result={testResult}
          pending={testPending}
          disabled={testDisabled}
          onTest={onTest}
        />
      ) : (
        <>
          <label className="studio-field">
            <span>节点名称</span>
            <input
              value={data.label}
              onChange={(event) => updateNode({ label: event.target.value })}
            />
          </label>
          <label className="studio-field">
            <span>说明</span>
            <input
              value={data.description}
              onChange={(event) => updateNode({ description: event.target.value })}
            />
          </label>
          <div className="inspector-section-title">参数</div>
          <VariableBindingsEditor
            node={node}
            nodes={nodes}
            edges={edges}
            updateConfig={updateConfig}
          />
          {providerError && data.kind === "llm" ? (
            <div className="node-resource-state is-error">{providerError}</div>
          ) : null}
          {resourceError && (data.kind === "rag" || data.kind === "mcp") ? (
            <div className="node-resource-state is-error">{resourceError}</div>
          ) : null}
          {data.kind === "mcp" && catalog && !catalog.mcp.configured ? (
            <div className="node-resource-state is-error">
              Agent Server 尚未配置 MCP Gateway API Key
            </div>
          ) : null}
          {data.kind === "rag" ? (
            <>
              <div className="studio-field">
                <span>挂载文档</span>
                <div className="workflow-resource-options">
                  {missingRagSources.map((source) => (
                    <label key={source} className="is-missing">
                      <input
                        type="checkbox"
                        checked
                        onChange={() =>
                          updateConfig(
                            "sources",
                            ragSources.filter((item) => item !== source),
                          )
                        }
                      />
                      <span>
                        <b>{source}</b>
                        <small>文档已失效，取消勾选可移除</small>
                      </span>
                    </label>
                  ))}
                  {loading && !catalog ? (
                    <div className="node-resource-state">正在加载文档...</div>
                  ) : (catalog?.rag.sources.length ?? 0) === 0 ? (
                    <div className="node-resource-state">暂无可挂载文档</div>
                  ) : (
                    catalog?.rag.sources.map((source) => (
                      <label key={source.source}>
                        <input
                          type="checkbox"
                          checked={ragSources.includes(source.source)}
                          onChange={(event) =>
                            updateConfig(
                              "sources",
                              event.target.checked
                                ? [...ragSources, source.source]
                                : ragSources.filter((item) => item !== source.source),
                            )
                          }
                        />
                        <span>
                          <b>{source.source}</b>
                          <small>{source.chunks} 个分块</small>
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
              <label className="range-field">
                <span>
                  Top-K <b>{String(data.config.topK)}</b>
                </span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={Number(data.config.topK)}
                  onChange={(event) => updateConfig("topK", Number(event.target.value))}
                />
              </label>
            </>
          ) : null}
          {data.kind === "llm" ? (
            <>
              <label className="studio-field">
                <span>Provider</span>
                <select
                  value={String(data.config.providerId ?? "default")}
                  onChange={(event) => {
                    const provider = providers.find((item) => item.id === event.target.value);
                    updateNode({
                      config: {
                        ...data.config,
                        providerId: event.target.value,
                        model: provider?.models[0] ?? "",
                      },
                    });
                  }}
                >
                  {providers.length === 0 ? (
                    <option value="default">暂无可用 Provider</option>
                  ) : null}
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="studio-field">
                <span>模型</span>
                <select
                  value={String(data.config.model)}
                  onChange={(event) => updateConfig("model", event.target.value)}
                >
                  {[
                    ...new Set([
                      String(data.config.model),
                      ...(providers.find(
                        (provider) => provider.id === String(data.config.providerId),
                      )?.models ?? []),
                    ]),
                  ]
                    .filter(Boolean)
                    .map((model) => (
                      <option key={model}>{model}</option>
                    ))}
                </select>
              </label>
              <label className="range-field">
                <span>
                  Temperature <b>{String(data.config.temperature)}</b>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={Number(data.config.temperature)}
                  onChange={(event) => updateConfig("temperature", Number(event.target.value))}
                />
              </label>
              <label className="studio-field">
                <span>系统提示词</span>
                <textarea
                  rows={6}
                  value={String(data.config.prompt)}
                  onChange={(event) => updateConfig("prompt", event.target.value)}
                />
              </label>
            </>
          ) : null}
          {data.kind === "mcp" ? (
            <>
              <label className="studio-field">
                <span>MCP 服务</span>
                <select
                  value={String(data.config.serviceSlug)}
                  disabled={loading}
                  onChange={(event) => {
                    updateNode({
                      config: {
                        ...data.config,
                        serviceSlug: event.target.value,
                        toolName: "",
                      },
                    });
                  }}
                >
                  <option value="">选择已授权服务</option>
                  {catalog?.mcp.services.map((service) => (
                    <option key={service.serviceSlug} value={service.serviceSlug}>
                      {service.serviceSlug}
                    </option>
                  ))}
                </select>
              </label>
              <label className="studio-field">
                <span>Tool</span>
                <select
                  value={String(data.config.toolName)}
                  disabled={!selectedService}
                  onChange={(event) => updateConfig("toolName", event.target.value)}
                >
                  <option value="">选择 Tool</option>
                  {selectedService?.tools.map((tool) => (
                    <option key={tool.name} value={tool.name}>
                      {tool.name}
                    </option>
                  ))}
                </select>
              </label>
              {selectedTool ? (
                <div className="workflow-tool-detail">
                  <p>{selectedTool.description ?? "该 Tool 未提供描述。"}</p>
                  <details>
                    <summary>Input Schema</summary>
                    <pre>{JSON.stringify(selectedTool.inputSchema, null, 2)}</pre>
                  </details>
                </div>
              ) : null}
              <label className="studio-field">
                <span>参数映射</span>
                <textarea
                  className="mono-input"
                  rows={7}
                  value={String(data.config.arguments)}
                  onChange={(event) => updateConfig("arguments", event.target.value)}
                />
              </label>
            </>
          ) : null}
          {(data.kind === "rag" || data.kind === "mcp") && !loading ? (
            <button className="resource-refresh-link" type="button" onClick={refreshResources}>
              <ReloadOutlined /> 刷新资源目录
            </button>
          ) : null}
          {data.kind === "condition" ? (
            <>
              <label className="studio-field">
                <span>条件表达式</span>
                <textarea
                  className="mono-input"
                  rows={5}
                  value={String(data.config.expression)}
                  onChange={(event) => updateConfig("expression", event.target.value)}
                />
              </label>
              <div className="condition-routes">
                <span>分支出口</span>
                {edges
                  .filter((edge) => edge.source === node.id)
                  .map((edge) => (
                    <label key={edge.id}>
                      <b>
                        {nodes.find((item) => item.id === edge.target)?.data.label ?? edge.target}
                      </b>
                      <select
                        value={typeof edge.label === "string" ? edge.label : ""}
                        onChange={(event) => updateEdgeLabel(edge.id, event.target.value)}
                      >
                        <option value="">默认</option>
                        <option value="true">True</option>
                        <option value="false">False</option>
                      </select>
                    </label>
                  ))}
                {edges.every((edge) => edge.source !== node.id) ? (
                  <small>连接下游节点后可配置 True / False 出口。</small>
                ) : null}
              </div>
            </>
          ) : null}
          {data.kind === "start" ? <p className="muted-copy">开始节点不需要额外参数。</p> : null}
        </>
      )}
    </div>
  );
}

function VariableBindingsEditor({
  node,
  nodes,
  edges,
  updateConfig,
}: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  edges: Edge[];
  updateConfig: (key: string, value: WorkflowConfigValue) => void;
}) {
  const inputs = nodeInputs(node.data);
  const outputs = nodeOutputs(node.data);
  const predecessors = edges
    .filter((edge) => edge.target === node.id)
    .map((edge) => nodes.find((item) => item.id === edge.source))
    .filter((item): item is WorkflowNode => Boolean(item));
  const predecessorOutputs = predecessors.flatMap((item) =>
    nodeOutputs(item.data).map((output) => ({
      nodeId: item.id,
      nodeLabel: item.data.label,
      output: output.name,
    })),
  );
  const updateInputs = (next: NodeInputBinding[]) => updateConfig("inputs", next);
  const updateOutputs = (next: NodeOutputBinding[]) => updateConfig("outputs", next);
  const sourceValue = (source: NodeInputBinding["source"]) =>
    source.type === "run"
      ? `run:${source.variable}`
      : source.type === "node"
        ? `node:${source.nodeId}:${source.output}`
        : "literal";
  const updateSource = (input: NodeInputBinding, value: string): NodeInputBinding => {
    if (value === "literal") return { ...input, source: { type: "literal", value: "" } };
    if (value.startsWith("node:")) {
      const [, nodeId, output] = value.split(":");
      return { ...input, source: { type: "node", nodeId: nodeId ?? "", output: output ?? "" } };
    }
    return { ...input, source: { type: "run", variable: value.slice(4) } };
  };
  return (
    <div className="variable-bindings">
      <div className="variable-group-head">
        <span>输入变量</span>
        <button
          type="button"
          onClick={() =>
            updateInputs([
              ...inputs,
              {
                name: `input${inputs.length + 1}`,
                source: { type: "run", variable: "" },
                required: true,
              },
            ])
          }
        >
          <PlusOutlined /> 添加
        </button>
      </div>
      {inputs.length === 0 ? (
        <small className="variable-empty">无输入绑定。可添加入口变量、固定值或前置节点输出。</small>
      ) : (
        inputs.map((input, index) => (
          <div className="variable-row" key={`${input.name}-${index}`}>
            <input
              className="variable-name"
              value={input.name}
              aria-label="输入变量名"
              onChange={(event) =>
                updateInputs(
                  inputs.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, name: event.target.value } : item,
                  ),
                )
              }
            />
            <select
              value={sourceValue(input.source)}
              aria-label="输入来源"
              onChange={(event) =>
                updateInputs(
                  inputs.map((item, itemIndex) =>
                    itemIndex === index ? updateSource(item, event.target.value) : item,
                  ),
                )
              }
            >
              <option value="literal">固定值</option>
              <option value={`run:${input.source.type === "run" ? input.source.variable : ""}`}>
                运行输入
              </option>
              {predecessorOutputs.map((item) => (
                <option
                  key={`${item.nodeId}:${item.output}`}
                  value={`node:${item.nodeId}:${item.output}`}
                >
                  {item.nodeLabel} · {item.output}
                </option>
              ))}
            </select>
            {input.source.type === "literal" ? (
              <input
                value={String(input.source.value ?? "")}
                aria-label="固定值"
                onChange={(event) =>
                  updateInputs(
                    inputs.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, source: { type: "literal", value: event.target.value } }
                        : item,
                    ),
                  )
                }
              />
            ) : null}
            {input.source.type === "run" ? (
              <input
                value={input.source.variable}
                aria-label="运行输入变量"
                placeholder="入口变量名"
                onChange={(event) =>
                  updateInputs(
                    inputs.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, source: { type: "run", variable: event.target.value } }
                        : item,
                    ),
                  )
                }
              />
            ) : null}
            <label className="variable-required" title="必填">
              <input
                type="checkbox"
                checked={input.required !== false}
                onChange={(event) =>
                  updateInputs(
                    inputs.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, required: event.target.checked } : item,
                    ),
                  )
                }
              />{" "}
              必填
            </label>
            <button
              type="button"
              className="variable-delete"
              title="删除输入"
              aria-label="删除输入"
              onClick={() => updateInputs(inputs.filter((_, itemIndex) => itemIndex !== index))}
            >
              <DeleteOutlined />
            </button>
          </div>
        ))
      )}
      <div className="variable-group-head">
        <span>输出变量</span>
        <button
          type="button"
          onClick={() =>
            updateOutputs([
              ...outputs,
              { name: `output${outputs.length + 1}`, selector: "$result" },
            ])
          }
        >
          <PlusOutlined /> 添加
        </button>
      </div>
      {outputs.length === 0 ? (
        <small className="variable-empty">无输出绑定。节点结果不会传给下游。</small>
      ) : (
        outputs.map((output, index) => (
          <div className="variable-row output-row" key={`${output.name}-${index}`}>
            <input
              className="variable-name"
              value={output.name}
              aria-label="输出变量名"
              onChange={(event) =>
                updateOutputs(
                  outputs.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, name: event.target.value } : item,
                  ),
                )
              }
            />
            <input
              className="mono-input"
              value={output.selector}
              aria-label="输出选择器"
              onChange={(event) =>
                updateOutputs(
                  outputs.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, selector: event.target.value } : item,
                  ),
                )
              }
            />
            <button
              type="button"
              className="variable-delete"
              title="删除输出"
              aria-label="删除输出"
              onClick={() => updateOutputs(outputs.filter((_, itemIndex) => itemIndex !== index))}
            >
              <DeleteOutlined />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function RunInputDialog({
  names,
  values,
  setValues,
  onCancel,
  onRun,
}: {
  names: string[];
  values: Record<string, string>;
  setValues: (values: Record<string, string>) => void;
  onCancel: () => void;
  onRun: () => void;
}) {
  return (
    <div className="settings-modal-backdrop" role="presentation">
      <div
        className="run-input-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-input-title"
      >
        <div className="settings-modal-head">
          <div>
            <span className="settings-kicker">RUN INPUTS</span>
            <h2 id="run-input-title">填写运行变量</h2>
          </div>
          <button type="button" aria-label="关闭" onClick={onCancel}>
            ×
          </button>
        </div>
        <p className="muted-copy">这些值会注入到 Workflow 的入口变量绑定。</p>
        <div className="run-input-fields">
          {names.map((name) => (
            <label className="studio-field" key={name}>
              <span>{name}</span>
              <input
                value={values[name] ?? ""}
                onChange={(event) => setValues({ ...values, [name]: event.target.value })}
                autoFocus={name === names[0]}
              />
            </label>
          ))}
        </div>
        <div className="settings-modal-actions">
          <button className="studio-button secondary" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="studio-button run" type="button" onClick={onRun}>
            <PlayCircleOutlined /> 开始运行
          </button>
        </div>
      </div>
    </div>
  );
}

function NodeTestInputDialog({
  node,
  values,
  setValues,
  onCancel,
  onRun,
}: {
  node: WorkflowNode;
  values: Record<string, string>;
  setValues: (values: Record<string, string>) => void;
  onCancel: () => void;
  onRun: () => void;
}) {
  const inputs = nodeInputs(node.data);
  return (
    <div className="settings-modal-backdrop" role="presentation">
      <div
        className="run-input-dialog node-test-input-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-test-input-title"
      >
        <div className="settings-modal-head">
          <div>
            <span className="settings-kicker">NODE TEST</span>
            <h2 id="node-test-input-title">测试运行 · {node.data.label}</h2>
          </div>
          <button type="button" aria-label="关闭" onClick={onCancel}>
            ×
          </button>
        </div>
        <p className="muted-copy">输入值只用于本次节点测试，支持字符串、数字和 JSON。</p>
        <div className="node-test-input-fields">
          {inputs.map((input, index) => (
            <label className="node-test-input-field" key={`${input.name}-${index}`}>
              <span>
                <b>{input.name}</b>
                <code>{describeNodeTestInputSource(input)}</code>
                {input.required !== false ? <small>必填</small> : null}
              </span>
              <textarea
                rows={3}
                aria-label={`测试输入 ${input.name}`}
                value={values[input.name] ?? ""}
                autoFocus={index === 0}
                onChange={(event) => setValues({ ...values, [input.name]: event.target.value })}
              />
            </label>
          ))}
        </div>
        <div className="settings-modal-actions">
          <button className="studio-button secondary" type="button" onClick={onCancel}>
            取消
          </button>
          <button className="studio-button run" type="button" onClick={onRun}>
            <PlayCircleOutlined /> 运行当前节点
          </button>
        </div>
      </div>
    </div>
  );
}

function NodeTestResultPanel({
  result,
  pending,
  disabled,
  onTest,
}: {
  result?: WorkflowNodeTestResult;
  pending: boolean;
  disabled: boolean;
  onTest: () => void;
}) {
  if (!result) {
    return (
      <div className="node-test-empty">
        {pending ? <span className="node-running" /> : <PlayCircleOutlined />}
        <b>{pending ? "节点测试运行中" : "暂无测试记录"}</b>
        <p>
          {pending
            ? "正在等待服务端返回执行结果。"
            : "单独运行当前节点后，可查看输入、输出和元数据。"}
        </p>
        {!pending ? (
          <button className="studio-button run" type="button" onClick={onTest} disabled={disabled}>
            <PlayCircleOutlined /> 测试运行
          </button>
        ) : null}
      </div>
    );
  }

  const usage = result.metadata.tokenUsage;
  return (
    <div className="node-test-result">
      <div className={`node-test-summary is-${result.status}`}>
        <span>
          <small>状态</small>
          <b>{result.status === "success" ? "SUCCESS" : "ERROR"}</b>
        </span>
        <span>
          <small>运行时间</small>
          <b>{formatNodeTestDuration(result.metadata.durationMs)}</b>
        </span>
        <span>
          <small>总 TOKEN 数</small>
          <b>{usage.totalTokens} Tokens</b>
        </span>
      </div>
      {result.error ? <div className="node-test-error">{result.error}</div> : null}
      <NodeTestDataBlock title="输入" value={result.inputs} />
      <NodeTestDataBlock title="数据处理" value={result.result} />
      <NodeTestDataBlock title="输出" value={result.outputs} />
      <div className="node-test-metadata">
        <div className="inspector-section-title">元数据</div>
        <dl>
          <div>
            <dt>状态</dt>
            <dd>{result.status.toUpperCase()}</dd>
          </div>
          <div>
            <dt>节点类型</dt>
            <dd>{result.metadata.nodeKind}</dd>
          </div>
          <div>
            <dt>节点 ID</dt>
            <dd>{result.nodeId}</dd>
          </div>
          <div>
            <dt>开始时间</dt>
            <dd>{formatNodeTestTime(result.metadata.startedAt)}</dd>
          </div>
          <div>
            <dt>结束时间</dt>
            <dd>{formatNodeTestTime(result.metadata.finishedAt)}</dd>
          </div>
          <div>
            <dt>运行时间</dt>
            <dd>{formatNodeTestDuration(result.metadata.durationMs)}</dd>
          </div>
          <div>
            <dt>输入 Tokens</dt>
            <dd>{usage.inputTokens}</dd>
          </div>
          <div>
            <dt>输出 Tokens</dt>
            <dd>{usage.outputTokens}</dd>
          </div>
          <div>
            <dt>总 Token 数</dt>
            <dd>{usage.totalTokens}</dd>
          </div>
        </dl>
      </div>
      <button
        className="studio-button secondary full-width node-test-rerun"
        type="button"
        onClick={onTest}
        disabled={pending || disabled}
      >
        <PlayCircleOutlined /> {pending ? "测试中..." : "重新测试"}
      </button>
    </div>
  );
}

function NodeTestDataBlock({ title, value }: { title: string; value: unknown }) {
  const formatted = formatWorkflowRunOutput(value);
  return (
    <section className="node-test-data-block">
      <header>
        <b>{title}</b>
        <button
          type="button"
          title={`复制${title}`}
          aria-label={`复制${title}`}
          onClick={() => void navigator.clipboard?.writeText(formatted)}
        >
          <CopyOutlined />
        </button>
      </header>
      <pre>{formatted}</pre>
    </section>
  );
}

function formatNodeTestDuration(durationMs: number): string {
  return `${(Math.max(0, durationMs) / 1000).toFixed(3)}s`;
}

function formatNodeTestTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function RunPreview({
  nodes,
  edges,
  running,
  runDisabled,
  log,
  outputs,
  onRun,
}: {
  nodes: WorkflowNode[];
  edges: Edge[];
  running: boolean;
  runDisabled: boolean;
  log: Array<{ id: string; label: string; status: "success" | "error"; detail?: string }>;
  outputs: Record<string, Record<string, unknown>> | null;
  onRun: () => void;
}) {
  const endNodes = nodes.filter((node) => node.data.kind === "end");
  return (
    <div className="inspector-content run-preview">
      <div className="run-summary">
        <span>
          <b>{nodes.length}</b> 节点
        </span>
        <span>
          <b>{edges.length}</b> 连接
        </span>
      </div>
      <p className="muted-copy">运行会在服务端按拓扑顺序执行节点，并实时回传节点状态。</p>
      <button
        className="studio-button run full-width"
        type="button"
        disabled={running || runDisabled}
        onClick={onRun}
      >
        <PlayCircleOutlined /> {running ? "正在运行..." : "开始运行"}
      </button>
      <div className="inspector-section-title">执行记录</div>
      {log.length === 0 ? (
        <div className="run-empty">尚未运行</div>
      ) : (
        <ol className="run-log">
          {log.map((item, index) => (
            <li key={item.id} className={item.status === "error" ? "is-error" : undefined}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <b>
                {item.label}
                {item.detail ? <small>{item.detail}</small> : null}
              </b>
              {item.status === "error" ? <CloseCircleFilled /> : <CheckCircleFilled />}
            </li>
          ))}
        </ol>
      )}
      {outputs !== null ? (
        <>
          <div className="inspector-section-title final-output-title">
            <span>最终输出</span>
            <span className="final-output-status">已完成</span>
          </div>
          {endNodes.length === 0 ? (
            <div className="run-empty">未配置结束节点</div>
          ) : (
            <div className="run-output-list">
              {endNodes.map((node) => {
                const bindings = nodeOutputs(node.data);
                const nodeValues = outputs[node.id];
                return (
                  <section className="run-output-block" key={node.id}>
                    <div className="run-output-heading">
                      <FlagOutlined />
                      <b>{node.data.label}</b>
                      <code>{node.id}</code>
                    </div>
                    {bindings.length === 0 ? (
                      <p className="run-output-empty">结束节点未配置输出变量</p>
                    ) : (
                      <div className="run-output-values">
                        {bindings.map((binding) => {
                          const hasValue = Boolean(
                            nodeValues &&
                            Object.prototype.hasOwnProperty.call(nodeValues, binding.name),
                          );
                          return (
                            <div className="run-output-value" key={binding.name}>
                              <div className="run-output-label">
                                <span>{binding.name}</span>
                                <code>{binding.selector}</code>
                              </div>
                              <pre>
                                {hasValue
                                  ? formatWorkflowRunOutput(nodeValues?.[binding.name])
                                  : "未执行"}
                              </pre>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function ApartmentMark() {
  return (
    <span className="workflow-mark">
      <BranchesOutlined />
    </span>
  );
}

function nodeColor(kind: NodeKind): string {
  if (kind === "rag") return "#c77921";
  if (kind === "mcp") return "#16806a";
  if (kind === "condition") return "#7a5da6";
  if (kind === "llm") return "#356bc4";
  return "#69717d";
}
