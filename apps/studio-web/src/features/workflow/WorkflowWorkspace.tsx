import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiOutlined,
  BranchesOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  FlagOutlined,
  PlayCircleFilled,
  PlayCircleOutlined,
  SaveOutlined,
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

type NodeKind = "start" | "input" | "rag" | "llm" | "mcp" | "condition" | "end";
type NodeRunStatus = "idle" | "running" | "success" | "error";

interface WorkflowNodeData extends Record<string, unknown> {
  label: string;
  description: string;
  kind: NodeKind;
  status: NodeRunStatus;
  config: Record<string, string | number | boolean>;
}

type WorkflowNode = Node<WorkflowNodeData, "studio">;

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

function defaultConfig(kind: NodeKind): Record<string, string | number | boolean> {
  if (kind === "rag") return { knowledgeBase: "", topK: 5, generate: false };
  if (kind === "llm")
    return { model: "gpt-4o-mini", temperature: 0.2, prompt: "基于检索上下文回答用户问题。" };
  if (kind === "mcp") return { service: "", tool: "", arguments: "{}" };
  if (kind === "condition") return { expression: "result != null" };
  if (kind === "input") return { variable: "query", required: true };
  if (kind === "end") return { output: "answer" };
  return {};
}

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
    return raw ? (JSON.parse(raw) as { name: string; nodes: WorkflowNode[]; edges: Edge[] }) : null;
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
    Array<{ id: string; label: string; status: "success" | "error" }>
  >([]);
  const runToken = useRef(0);
  const { screenToFlowPosition } = useReactFlow();

  useEffect(
    () => () => {
      runToken.current += 1;
    },
    [],
  );

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

  const updateConfig = (key: string, value: string | number | boolean) => {
    if (!selectedNode) return;
    updateSelected({ config: { ...selectedNode.data.config, [key]: value } });
  };

  const removeSelected = () => {
    if (!selectedId) return;
    setNodes((current) => current.filter((node) => node.id !== selectedId));
    setEdges((current) =>
      current.filter((edge) => edge.source !== selectedId && edge.target !== selectedId),
    );
    setSelectedId(null);
    setDirty(true);
  };

  const save = () => {
    localStorage.setItem(storageKey, JSON.stringify({ name, nodes, edges }));
    setDirty(false);
  };

  const run = async () => {
    if (running) return;
    const token = ++runToken.current;
    const ordered = traversalOrder(nodes, edges);
    setRunning(true);
    setRunLog([]);
    setNodes((current) =>
      current.map((node) => ({ ...node, data: { ...node.data, status: "idle" } })),
    );
    for (const node of ordered) {
      if (runToken.current !== token) return;
      setNodes((current) =>
        current.map((item) =>
          item.id === node.id ? { ...item, data: { ...item.data, status: "running" } } : item,
        ),
      );
      await delay(420);
      if (runToken.current !== token) return;
      setNodes((current) =>
        current.map((item) =>
          item.id === node.id ? { ...item, data: { ...item.data, status: "success" } } : item,
        ),
      );
      setRunLog((current) => [
        ...current,
        { id: node.id, label: node.data.label, status: "success" },
      ]);
    }
    setRunning(false);
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
            disabled={running}
            onClick={() => void run()}
          >
            <PlayCircleOutlined /> {running ? "运行中" : "运行预览"}
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
            minZoom={0.35}
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
              updateNode={updateSelected}
              updateConfig={updateConfig}
            />
          ) : (
            <RunPreview
              nodes={nodes}
              edges={edges}
              running={running}
              log={runLog}
              onRun={() => void run()}
            />
          )}
        </aside>
      </div>
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
  if (data.kind === "rag")
    return data.config.knowledgeBase
      ? String(data.config.knowledgeBase)
      : `Top-${data.config.topK} 混合检索`;
  if (data.kind === "llm") return String(data.config.model);
  if (data.kind === "mcp")
    return data.config.tool ? `${data.config.service} / ${data.config.tool}` : "选择 MCP Tool";
  if (data.kind === "condition") return String(data.config.expression);
  if (data.kind === "input") return `变量：${data.config.variable}`;
  if (data.kind === "end") return `输出：${data.config.output}`;
  return "点击运行开始执行";
}

function NodeInspector({
  node,
  updateNode,
  updateConfig,
}: {
  node: WorkflowNode;
  updateNode: (patch: Partial<WorkflowNodeData>) => void;
  updateConfig: (key: string, value: string | number | boolean) => void;
}) {
  const { data } = node;
  return (
    <div className="inspector-content node-inspector-content">
      <div className="inspector-title-row">
        <span className={`node-icon kind-${data.kind}`}>{iconByKind[data.kind]}</span>
        <div>
          <h2>{data.label}</h2>
          <p>{palette.find((item) => item.kind === data.kind)?.group}</p>
        </div>
      </div>
      <label className="studio-field">
        <span>节点名称</span>
        <input value={data.label} onChange={(event) => updateNode({ label: event.target.value })} />
      </label>
      <label className="studio-field">
        <span>说明</span>
        <input
          value={data.description}
          onChange={(event) => updateNode({ description: event.target.value })}
        />
      </label>
      <div className="inspector-section-title">参数</div>
      {data.kind === "rag" ? (
        <>
          <label className="studio-field">
            <span>知识库</span>
            <input
              value={String(data.config.knowledgeBase)}
              onChange={(event) => updateConfig("knowledgeBase", event.target.value)}
              placeholder="选择或输入知识库"
            />
          </label>
          <label className="range-field">
            <span>
              Top-K <b>{data.config.topK}</b>
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
            <span>模型</span>
            <select
              value={String(data.config.model)}
              onChange={(event) => updateConfig("model", event.target.value)}
            >
              <option>gpt-4o-mini</option>
              <option>gpt-4o</option>
              <option>o3-mini</option>
            </select>
          </label>
          <label className="range-field">
            <span>
              Temperature <b>{data.config.temperature}</b>
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
            <input
              value={String(data.config.service)}
              onChange={(event) => updateConfig("service", event.target.value)}
              placeholder="service-slug"
            />
          </label>
          <label className="studio-field">
            <span>Tool</span>
            <input
              value={String(data.config.tool)}
              onChange={(event) => updateConfig("tool", event.target.value)}
              placeholder="tool_name"
            />
          </label>
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
      {data.kind === "condition" ? (
        <label className="studio-field">
          <span>条件表达式</span>
          <textarea
            className="mono-input"
            rows={5}
            value={String(data.config.expression)}
            onChange={(event) => updateConfig("expression", event.target.value)}
          />
        </label>
      ) : null}
      {data.kind === "input" ? (
        <>
          <label className="studio-field">
            <span>变量名</span>
            <input
              value={String(data.config.variable)}
              onChange={(event) => updateConfig("variable", event.target.value)}
            />
          </label>
          <label className="toggle-field">
            <span>
              <b>必填</b>
              <small>运行前校验输入</small>
            </span>
            <input
              type="checkbox"
              checked={Boolean(data.config.required)}
              onChange={(event) => updateConfig("required", event.target.checked)}
            />
          </label>
        </>
      ) : null}
      {data.kind === "end" ? (
        <label className="studio-field">
          <span>输出变量</span>
          <input
            value={String(data.config.output)}
            onChange={(event) => updateConfig("output", event.target.value)}
          />
        </label>
      ) : null}
      {data.kind === "start" ? <p className="muted-copy">开始节点不需要额外参数。</p> : null}
    </div>
  );
}

function RunPreview({
  nodes,
  edges,
  running,
  log,
  onRun,
}: {
  nodes: WorkflowNode[];
  edges: Edge[];
  running: boolean;
  log: Array<{ id: string; label: string; status: "success" | "error" }>;
  onRun: () => void;
}) {
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
      <p className="muted-copy">
        运行预览会按连线顺序检查节点配置与数据流，不会调用真实模型或工具。
      </p>
      <button
        className="studio-button run full-width"
        type="button"
        disabled={running}
        onClick={onRun}
      >
        <PlayCircleOutlined /> {running ? "正在预览..." : "开始运行预览"}
      </button>
      <div className="inspector-section-title">执行记录</div>
      {log.length === 0 ? (
        <div className="run-empty">尚未运行</div>
      ) : (
        <ol className="run-log">
          {log.map((item, index) => (
            <li key={item.id}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <b>{item.label}</b>
              <CheckCircleFilled />
            </li>
          ))}
        </ol>
      )}
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

function traversalOrder(nodes: WorkflowNode[], edges: Edge[]): WorkflowNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  edges.forEach((edge) => incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1));
  const queue = nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .sort((a, b) => a.position.x - b.position.x);
  const ordered: WorkflowNode[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (ordered.some((item) => item.id === node.id)) continue;
    ordered.push(node);
    edges
      .filter((edge) => edge.source === node.id)
      .forEach((edge) => {
        const count = (incoming.get(edge.target) ?? 1) - 1;
        incoming.set(edge.target, count);
        if (count === 0 && byId.get(edge.target)) queue.push(byId.get(edge.target)!);
      });
  }
  return ordered.length === nodes.length
    ? ordered
    : [...nodes].sort((a, b) => a.position.x - b.position.x);
}

function nodeColor(kind: NodeKind): string {
  if (kind === "rag") return "#c77921";
  if (kind === "mcp") return "#16806a";
  if (kind === "condition") return "#7a5da6";
  if (kind === "llm") return "#356bc4";
  return "#69717d";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
