import { useCallback, useEffect, useState } from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ApartmentOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
} from "../../lib/icons.js";
import {
  listEntities,
  neighborsOf,
  reconcileGraph,
  relationTypes,
  retrieveGraph,
  syncStatus,
  type EntityInfo,
  type GraphExport,
  type GraphNode,
  type RelationTypeStat,
  type SyncStatus,
} from "./api.js";

/** 实体类型 → 配色（浅色主题）。 */
const TYPE_COLORS: Record<string, { fill: string; stroke: string; text: string }> = {
  org: { fill: "#E6F1FB", stroke: "#185FA5", text: "#0C447C" },
  tech: { fill: "#EEEDFE", stroke: "#534AB7", text: "#3C3489" },
  product: { fill: "#FAEEDA", stroke: "#854F0B", text: "#633806" },
  person: { fill: "#E1F5EE", stroke: "#0F6E56", text: "#085041" },
  place: { fill: "#FBEAF0", stroke: "#993556", text: "#72243E" },
};
const FALLBACK_COLOR = { fill: "#F1EFE8", stroke: "#5F5E5A", text: "#444441" };

function colorFor(type: string) {
  return TYPE_COLORS[type] ?? FALLBACK_COLOR;
}

interface GraphNodeData extends Record<string, unknown> {
  name: string;
  type: string;
  entityId: string;
}

type GraphFlowNode = Node<GraphNodeData, "graphNode">;

function GraphNodeView({ data }: NodeProps<GraphFlowNode>) {
  const color = colorFor(data.type);
  return (
    <div
      style={{
        background: color.fill,
        border: `1px solid ${color.stroke}`,
        borderRadius: 8,
        padding: "6px 10px",
        minWidth: 64,
        textAlign: "center",
        fontSize: 12,
        cursor: "pointer",
      }}
    >
      <div style={{ fontWeight: 500, color: color.text, whiteSpace: "nowrap" }}>{data.name}</div>
      <div style={{ fontSize: 10, color: color.stroke, marginTop: 2 }}>{data.type}</div>
    </div>
  );
}

const nodeTypes: NodeTypes = { graphNode: GraphNodeView };

/** 简单环形布局：seed 居中，其余节点围绕排列。 */
function layoutGraph(exportData: GraphExport): GraphFlowNode[] {
  const centerId = exportData.nodes[0]?.id;
  const ring = exportData.nodes.filter((n) => n.id !== centerId);
  return exportData.nodes.map((node) => {
    const ringIndex = ring.findIndex((n) => n.id === node.id);
    const isCenter = node.id === centerId;
    const angle = ringIndex >= 0 ? (ringIndex / Math.max(1, ring.length)) * Math.PI * 2 : 0;
    const radius = 160;
    return {
      id: `node-${node.id}`,
      type: "graphNode",
      position: isCenter
        ? { x: 300, y: 200 }
        : {
            x: 300 + Math.cos(angle) * radius - 40,
            y: 200 + Math.sin(angle) * radius - 24,
          },
      data: { name: node.name, type: node.type, entityId: node.id },
    };
  });
}

function edgesFrom(exportData: GraphExport): Edge[] {
  return exportData.edges.map((edge) => ({
    id: `edge-${edge.id}`,
    source: `node-${edge.source}`,
    target: `node-${edge.target}`,
    label: edge.relType,
    style: { stroke: "#B4B2A9", strokeWidth: 1 },
    labelStyle: { fontSize: 10, fill: "#888780" },
    markerEnd: { type: MarkerType.ArrowClosed, color: "#B4B2A9" },
  }));
}

/** 合并子图：按 id 去重合并节点与边。 */
function mergeExport(current: GraphExport | null, incoming: GraphExport): GraphExport {
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, { id: string; source: string; target: string; relType: string; weight: number }>();
  for (const group of [current, incoming]) {
    if (!group) continue;
    for (const node of group.nodes) nodeMap.set(node.id, node);
    for (const edge of group.edges) edgeMap.set(edge.id, edge);
  }
  return {
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
    stats: { entities: nodeMap.size, relations: edgeMap.size },
  };
}

function GraphCanvas({ data, onNodeClick }: { data: GraphExport | null; onNodeClick: (id: string) => void }) {
  const [nodes, setNodes] = useState<GraphFlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  useEffect(() => {
    if (!data) {
      setNodes([]);
      setEdges([]);
      return;
    }
    setNodes(layoutGraph(data));
    setEdges(edgesFrom(data));
  }, [data]);

  const onNodesChange = useCallback<OnNodesChange<GraphFlowNode>>(
    (changes) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  const onEdgesChange = useCallback<OnEdgesChange>(
    (changes) => setEdges((current) => applyEdgeChanges(changes, current)),
    [],
  );

  return (
    <div style={{ height: "100%", minHeight: 420 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_event, node) => onNodeClick((node.data as GraphNodeData).entityId)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable
        minZoom={0.3}
        maxZoom={2}
      >
        <Background gap={16} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

/** 同步状态条：把「图谱是否忠实反映当前知识库」这件事显性化，避免用户对着陈旧图谱做判断。 */
function GraphSyncBar({
  status,
  syncing,
  onReconcile,
}: {
  status: SyncStatus | null;
  syncing: boolean;
  onReconcile: () => void;
}) {
  if (!status) return null;

  const pending = status.building.length + status.queued;
  const drifted = status.missing.length + status.stale.length + status.orphan.length;
  const tone = pending > 0 ? "building" : status.inSync ? "ok" : "drift";
  const detail: string[] = [];
  if (status.missing.length > 0) detail.push(`${status.missing.length} 篇待建图`);
  if (status.stale.length > 0) detail.push(`${status.stale.length} 篇已过期`);
  if (status.orphan.length > 0) detail.push(`${status.orphan.length} 项残留`);

  const label =
    pending > 0
      ? `正在抽取 ${status.building.join("、") || "文档"}${status.queued > 0 ? `，另有 ${status.queued} 篇排队` : ""}`
      : status.inSync
        ? `图谱与知识库已同步 · ${status.ragSources.length} 篇文档 / ${status.stats.entities} 实体 / ${status.stats.relations} 关系`
        : `图谱与知识库不一致：${detail.join("，")}`;

  return (
    <div className={`graph-sync-bar is-${tone}`} role="status">
      <span className="graph-sync-dot" />
      <span className="graph-sync-label">{label}</span>
      {drifted > 0 && pending === 0 ? (
        <button
          className="studio-button secondary"
          type="button"
          onClick={onReconcile}
          disabled={syncing}
        >
          <SyncOutlined spin={syncing} /> {syncing ? "同步中" : "一键同步"}
        </button>
      ) : null}
    </div>
  );
}

export function GraphWorkspace() {
  const [query, setQuery] = useState("");
  const [exportData, setExportData] = useState<GraphExport | null>(null);
  const [selected, setSelected] = useState<EntityInfo | null>(null);
  const [entities, setEntities] = useState<EntityInfo[]>([]);
  const [relTypes, setRelTypes] = useState<RelationTypeStat[]>([]);
  const [busy, setBusy] = useState<"search" | "expand" | "list" | null>(null);
  const [notice, setNotice] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refreshSync = useCallback(async () => {
    try {
      setSync(await syncStatus());
    } catch {
      // 对账失败不打断主流程（图谱本身仍可查询），保持上一次状态
    }
  }, []);

  const refreshEntities = useCallback(async () => {
    setBusy("list");
    try {
      const [entityResult, typeResult] = await Promise.all([listEntities({ limit: 100 }), relationTypes()]);
      setEntities(entityResult.entities);
      setRelTypes(typeResult.types);
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void refreshEntities();
    void refreshSync();
  }, [refreshEntities, refreshSync]);

  // 后台抽取是异步的，构建期间轮询直到落地，否则用户看不到图谱何时可用
  const inProgress = (sync?.building.length ?? 0) + (sync?.queued ?? 0) > 0;
  useEffect(() => {
    if (!inProgress) return;
    const timer = setInterval(() => {
      void (async () => {
        const next = await syncStatus().catch(() => null);
        if (!next) return;
        setSync(next);
        if (next.building.length + next.queued === 0) void refreshEntities();
      })();
    }, 2000);
    return () => clearInterval(timer);
  }, [inProgress, refreshEntities]);

  const handleReconcile = async () => {
    setSyncing(true);
    setNotice(null);
    try {
      const result = await reconcileGraph();
      setSync(result.status);
      await refreshEntities();
      const parts: string[] = [];
      if (result.rebuilt.length > 0) parts.push(`重建 ${result.rebuilt.length} 篇`);
      if (result.removed.length > 0) parts.push(`清理 ${result.removed.length} 项残留`);
      if (result.failed.length > 0) parts.push(`${result.failed.length} 篇失败`);
      setNotice({
        type: result.failed.length > 0 ? "error" : "success",
        text: parts.length > 0 ? `同步完成：${parts.join("，")}` : "已是最新状态",
      });
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setSyncing(false);
    }
  };

  const runSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setBusy("search");
    setNotice(null);
    try {
      const result = await retrieveGraph(trimmed, 2);
      if (!result.subgraph || result.subgraph.nodes.length === 0) {
        setExportData(null);
        setNotice({ type: "error", text: "知识图谱中未找到相关实体" });
        return;
      }
      setExportData(result.subgraph);
      setNotice({ type: "success", text: `命中种子: ${result.seeds.map((s) => s.name).join("、") || "无"}` });
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(null);
    }
  };

  const expandEntity = async (entityId: string) => {
    setBusy("expand");
    try {
      const [neighbors, info] = await Promise.all([
        neighborsOf(entityId, 2),
        listEntities({ search: entityId, limit: 1 }),
      ]);
      setSelected(info.entities[0] ?? null);
      setExportData((current) => mergeExport(current, neighbors));
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(null);
    }
  };

  const stats = exportData?.stats ?? null;

  return (
    <section className="domain-workspace graph-workspace">
      <header className="domain-header">
        <div>
          <p className="domain-eyebrow">上下文工程 / 知识图谱</p>
          <h1>知识图谱</h1>
        </div>
        <div className="domain-header-actions">
          <span className="capability-state is-on">
            <span /> GraphRAG
          </span>
          <button
            className="studio-button secondary"
            type="button"
            onClick={() => {
              setNotice(null);
              void refreshEntities();
              void refreshSync();
            }}
          >
            <ReloadOutlined /> 刷新
          </button>
        </div>
      </header>

      <GraphSyncBar status={sync} syncing={syncing} onReconcile={() => void handleReconcile()} />

      {notice ? <div className={`workspace-notice ${notice.type}`} role="status">{notice.text}</div> : null}

      <div className="graph-search-bar">
        <SearchOutlined />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void runSearch();
          }}
          placeholder="输入实体名或问题，定位种子并扩展子图（如：OpenAI）"
        />
        <button
          className="studio-button primary"
          type="button"
          disabled={!query.trim() || busy === "search"}
          onClick={() => void runSearch()}
        >
          {busy === "search" ? "检索中..." : "子图检索"}
        </button>
      </div>

      <div className="graph-layout">
        <aside className="graph-side-panel">
          <div className="panel-heading">
            <span>实体索引</span>
            <span className="count-badge">{entities.length}</span>
          </div>
          {busy === "list" ? <div className="panel-state">正在加载实体...</div> : null}
          {!busy && entities.length === 0 ? (
            <div className="panel-state">上传文档后自动抽取实体；也可先手动触发抽取。</div>
          ) : null}
          <div className="graph-entity-list">
            {entities.map((entity) => {
              const color = colorFor(entity.type);
              return (
                <button
                  type="button"
                  key={entity.id}
                  className="graph-entity-item"
                  onClick={() => {
                    setQuery(entity.name);
                    void runSearch();
                  }}
                >
                  <span className="graph-entity-dot" style={{ background: color.stroke }} />
                  <span className="graph-entity-name">{entity.name}</span>
                  <span className="graph-entity-type">{entity.type}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <div className="graph-canvas-panel">
          <div className="graph-canvas-heading">
            <span>
              <ApartmentOutlined /> 子图 {stats ? `${stats.entities} 实体 · ${stats.relations} 关系` : "未检索"}
            </span>
            <span className="graph-legend">
              {Object.keys(TYPE_COLORS).map((type) => (
                <span key={type} className="graph-legend-item">
                  <span className="graph-legend-dot" style={{ background: colorFor(type).stroke }} />
                  {type}
                </span>
              ))}
            </span>
          </div>
          <GraphCanvas data={exportData} onNodeClick={(id) => void expandEntity(id)} />
          <div className="graph-canvas-hint">点击节点可动态展开 2 跳邻域；拖拽节点调整布局。</div>
        </div>

        <aside className="graph-inspector">
          <div className="panel-heading">
            <span>实体详情</span>
          </div>
          {selected ? (
            <div className="graph-inspector-content">
              <div className="graph-inspector-name">{selected.name}</div>
              <div className="graph-inspector-type">{selected.type}</div>
              {Object.keys(selected.props ?? {}).length > 0 ? (
                <div className="graph-inspector-props">
                  {Object.entries(selected.props).map(([key, value]) => (
                    <div key={key} className="graph-prop-row">
                      <span>{key}</span>
                      <span>{value}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="graph-inspector-empty">该实体暂无附加属性（规则抽取通常无 props）。</p>
              )}
            </div>
          ) : (
            <div className="panel-state">点击图中节点查看实体详情</div>
          )}
          {relTypes.length > 0 ? (
            <div className="graph-rel-types">
              <div className="panel-heading">
                <span>关系分布</span>
              </div>
              {relTypes.map((item) => (
                <div key={item.relType} className="graph-rel-row">
                  <span>{item.relType}</span>
                  <span className="count-badge">{item.count}</span>
                </div>
              ))}
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

export function GraphWorkspaceWithProvider() {
  return (
    <ReactFlowProvider>
      <GraphWorkspace />
    </ReactFlowProvider>
  );
}
