import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Input,
  List,
  Select,
  Spin,
  Tag,
  Typography,
} from "antd";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
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
  SyncOutlined,
} from "../../lib/icons.js";
import { StudioPage } from "../../components/studio/StudioPageHeader.js";
import { StudioNotice, type StudioNoticeValue } from "../../components/studio/StudioNotice.js";
import { UsageTag } from "../../components/UsageTag.js";
import type { MessageUsage } from "../../types.js";
import { listDocuments, type DocumentSource } from "../rag/api.js";
import {
  documentGraph,
  neighborsOf,
  reconcileGraph,
  retrieveGraph,
  syncStatus,
  type DocumentGraph,
  type EntityInfo,
  type GraphEdge,
  type GraphExport,
  type GraphNode,
  type SyncStatus,
} from "./api.js";
import { RelationEdge } from "./RelationEdge.js";
import {
  parallelCurveOffsets,
  RELATION_PORTS,
  rerouteRelationEdges,
  type RelationFlowEdge,
} from "./relationRouting.js";

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
      className="graph-node"
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
      {RELATION_PORTS.map((port) => (
        <Handle
          key={`${port.name}-target`}
          id={`${port.name}-target`}
          type="target"
          position={port.position}
          isConnectable={false}
        />
      ))}
      {RELATION_PORTS.map((port) => (
        <Handle
          key={`${port.name}-source`}
          id={`${port.name}-source`}
          type="source"
          position={port.position}
          isConnectable={false}
        />
      ))}
    </div>
  );
}

const nodeTypes: NodeTypes = { graphNode: GraphNodeView };
const edgeTypes = { relation: RelationEdge };

/** 简单环形布局：seed 居中，其余节点围绕排列。 */
function layoutGraph(exportData: GraphExport): GraphFlowNode[] {
  const centerId = exportData.nodes[0]?.id;
  const ring = exportData.nodes.filter((n) => n.id !== centerId);
  let ringIndex = -1;
  return exportData.nodes.map((node) => {
    const isCenter = node.id === centerId;
    if (!isCenter) ringIndex += 1;
    const ringNumber = ringIndex >= 0 ? Math.floor(ringIndex / 12) : 0;
    const indexInRing = ringIndex >= 0 ? ringIndex % 12 : 0;
    const countInRing = Math.min(12, Math.max(1, ring.length - ringNumber * 12));
    const angle = (indexInRing / countInRing) * Math.PI * 2 - Math.PI / 2;
    const radius = 160 + ringNumber * 110;
    return {
      id: `node-${node.id}`,
      type: "graphNode",
      position: isCenter
        ? { x: 320, y: 210 }
        : {
            x: 320 + Math.cos(angle) * radius - 40,
            y: 210 + Math.sin(angle) * radius - 24,
          },
      data: { name: node.name, type: node.type, entityId: node.id },
    };
  });
}

function edgesFrom(exportData: GraphExport, nodes: GraphFlowNode[]): RelationFlowEdge[] {
  const offsets = parallelCurveOffsets(exportData.edges);
  const edges: RelationFlowEdge[] = exportData.edges.map((edge) => {
    const source = `node-${edge.source}`;
    const target = `node-${edge.target}`;
    return {
      id: `edge-${edge.id}`,
      source,
      target,
      type: "relation",
      label: edge.relType,
      data: {
        relType: edge.relType,
        rawId: edge.id,
        curveOffset: offsets.get(edge.id) ?? 0,
        showLabel: exportData.edges.length <= 24,
      },
      interactionWidth: 26,
      style: { stroke: "#9a978f", strokeWidth: 1.3 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#9a978f" },
    };
  });
  return rerouteRelationEdges(edges, nodes);
}

/** 合并子图：按 id 去重合并节点与边。 */
function mergeExport(current: GraphExport | null, incoming: GraphExport): GraphExport {
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<
    string,
    { id: string; source: string; target: string; relType: string; weight: number }
  >();
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

function GraphCanvas({
  data,
  selectedEdgeId,
  onNodeClick,
  onEdgeClick,
  onPaneClick,
}: {
  data: GraphExport | null;
  selectedEdgeId: string | null;
  onNodeClick: (id: string) => void;
  onEdgeClick: (edgeId: string, sourceName: string, targetName: string) => void;
  onPaneClick: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<GraphFlowNode[]>([]);
  const [edges, setEdges] = useState<RelationFlowEdge[]>([]);
  const { fitView } = useReactFlow<GraphFlowNode, RelationFlowEdge>();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => void fitView({ padding: 0.2 }));
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [fitView]);

  useEffect(() => {
    if (!data) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const nextNodes = layoutGraph(data);
    setNodes(nextNodes);
    setEdges(edgesFrom(data, nextNodes));
    // 等新节点提交到 React Flow 后再适配视图，后续检索与展开也需要重新定位。
    const frame = requestAnimationFrame(() => void fitView({ padding: 0.2 }));
    return () => cancelAnimationFrame(frame);
  }, [data, fitView]);

  useEffect(() => {
    const showAll = (data?.edges.length ?? 0) <= 24;
    setEdges((current) =>
      current.map((edge) => ({
        ...edge,
        data: edge.data
          ? {
              ...edge.data,
              showLabel: showAll || edge.data?.rawId === selectedEdgeId,
            }
          : {
              relType: String(edge.label ?? ""),
              rawId: edge.id.replace(/^edge-/, ""),
              curveOffset: 0,
              showLabel: showAll,
            },
      })),
    );
  }, [data, selectedEdgeId]);

  useEffect(() => {
    setEdges((current) => rerouteRelationEdges(current, nodes));
  }, [nodes]);

  const onNodesChange = useCallback<OnNodesChange<GraphFlowNode>>(
    (changes) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  const onEdgesChange = useCallback<OnEdgesChange<RelationFlowEdge>>(
    (changes) => setEdges((current) => applyEdgeChanges(changes, current) as RelationFlowEdge[]),
    [],
  );

  const nodeByFlowId = new Map(nodes.map((node) => [node.id, node.data.name]));

  return (
    <div ref={containerRef} style={{ height: "100%", minHeight: 420 }}>
      <ReactFlow
        style={{ minHeight: 420 }}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_event, node) => onNodeClick((node.data as GraphNodeData).entityId)}
        onEdgeClick={(_event, edge) => {
          onEdgeClick(
            edge.data?.rawId ?? edge.id.replace(/^edge-/, ""),
            nodeByFlowId.get(edge.source) ?? "",
            nodeByFlowId.get(edge.target) ?? "",
          );
        }}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable
        elementsSelectable
        edgesFocusable
        connectionMode={ConnectionMode.Loose}
        minZoom={0.001}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
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
  lastUsage,
  onReconcile,
}: {
  status: SyncStatus | null;
  syncing: boolean;
  lastUsage?: MessageUsage;
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

  const alertType = tone === "ok" ? "success" : tone === "building" ? "info" : "warning";
  return (
    <Alert
      showIcon
      type={alertType}
      message={label}
      description={
        status.usage || lastUsage ? (
          <Flex vertical gap={4}>
            {status.usage ? (
              <span>
                当前空间累计建图用量 · <UsageTag usage={status.usage} />
              </span>
            ) : null}
            {lastUsage ? (
              <span>
                本次建图用量 · <UsageTag usage={lastUsage} />
              </span>
            ) : null}
          </Flex>
        ) : undefined
      }
      action={
        drifted > 0 && pending === 0 ? (
          <Button
            size="small"
            icon={<SyncOutlined spin={syncing} />}
            loading={syncing}
            onClick={onReconcile}
          >
            {syncing ? "同步中" : "一键同步"}
          </Button>
        ) : undefined
      }
    />
  );
}

export function GraphWorkspace() {
  const { message } = App.useApp();
  const [documents, setDocuments] = useState<DocumentSource[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [source, setSource] = useState<string>();
  const [documentData, setDocumentData] = useState<DocumentGraph | null>(null);
  const [graphRevision, setGraphRevision] = useState(0);
  const requestId = useRef(0);
  const [query, setQuery] = useState("");
  const [exportData, setExportData] = useState<GraphExport | null>(null);
  const [selected, setSelected] = useState<EntityInfo | null>(null);
  const [selectedRelation, setSelectedRelation] = useState<{
    edge: GraphEdge;
    sourceName: string;
    targetName: string;
  } | null>(null);
  const [busy, setBusy] = useState<"search" | "expand" | "list" | null>(null);
  const [notice, setNotice] = useState<StudioNoticeValue | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [usage, setUsage] = useState<MessageUsage>();
  const [buildUsage, setBuildUsage] = useState<MessageUsage>();
  const entities = documentData?.nodes ?? [];
  const relTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of documentData?.edges ?? []) {
      counts.set(edge.relType, (counts.get(edge.relType) ?? 0) + 1);
    }
    return [...counts].map(([relType, count]) => ({ relType, count })).sort((a, b) => b.count - a.count);
  }, [documentData]);

  const refreshDocuments = useCallback(async () => {
    setDocumentsLoading(true);
    try {
      setDocuments((await listDocuments()).sources);
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setDocumentsLoading(false);
    }
  }, []);

  const refreshSync = useCallback(async () => {
    try {
      setSync(await syncStatus());
    } catch {
      // 对账失败不打断主流程（图谱本身仍可查询），保持上一次状态
    }
  }, []);

  const refreshDocument = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setDocumentData(null);
    setExportData(null);
    setSelected(null);
    setSelectedRelation(null);
    setUsage(undefined);
    if (!source) {
      setBusy(null);
      return;
    }
    setBusy("list");
    try {
      const result = await documentGraph(source);
      if (currentRequest !== requestId.current) return;
      setDocumentData(result);
      setExportData(result);
    } catch (reason) {
      if (currentRequest !== requestId.current) return;
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      if (currentRequest === requestId.current) setBusy(null);
    }
  }, [source]);

  useEffect(() => {
    void refreshDocuments();
    void refreshSync();
  }, [refreshDocuments, refreshSync]);

  useEffect(() => {
    void refreshDocument();
    return () => { requestId.current += 1; };
  }, [refreshDocument, graphRevision]);

  useEffect(() => {
    if (source && !documentsLoading && !documents.some((document) => document.source === source)) {
      requestId.current += 1;
      setSource(undefined);
      setQuery("");
      setNotice({ type: "error", text: "所选文档已失效，请重新选择文档" });
    }
  }, [documents, documentsLoading, source]);

  // 后台抽取是异步的，构建期间轮询直到落地，否则用户看不到图谱何时可用
  const inProgress = (sync?.building.length ?? 0) + (sync?.queued ?? 0) > 0;
  useEffect(() => {
    if (!inProgress) return;
    const timer = setInterval(() => {
      void (async () => {
        const next = await syncStatus().catch(() => null);
        if (!next) return;
        setSync(next);
        if (next.building.length + next.queued === 0) setGraphRevision((value) => value + 1);
      })();
    }, 2000);
    return () => clearInterval(timer);
  }, [inProgress]);

  const handleReconcile = async () => {
    setSyncing(true);
    setNotice(null);
    setBuildUsage(undefined);
    try {
      const result = await reconcileGraph();
      setSync(result.status);
      setBuildUsage(result.usage);
      setGraphRevision((value) => value + 1);
      await Promise.all([refreshDocuments(), refreshSync()]);
      const parts: string[] = [];
      if (result.rebuilt.length > 0) parts.push(`重建 ${result.rebuilt.length} 篇`);
      if (result.removed.length > 0) parts.push(`清理 ${result.removed.length} 项残留`);
      if (result.failed.length > 0) parts.push(`${result.failed.length} 篇失败`);
      const text = parts.length > 0 ? `同步完成：${parts.join("，")}` : "已是最新状态";
      setNotice({
        type: result.failed.length > 0 ? "error" : "success",
        text,
      });
      if (result.failed.length === 0) void message.success(text);
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setSyncing(false);
    }
  };

  const runSearch = async (searchQuery = query) => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    if (!source) {
      setNotice({ type: "error", text: "请先选择文档，再检索图谱" });
      return;
    }
    const currentRequest = ++requestId.current;
    setBusy("search");
    setNotice(null);
    setUsage(undefined);
    try {
      const result = await retrieveGraph(trimmed, 2, [source]);
      if (currentRequest !== requestId.current) return;
      setUsage(result.usage);
      setSelected(null);
      setSelectedRelation(null);
      if (!result.subgraph || result.subgraph.nodes.length === 0) {
        setExportData(null);
        setNotice({ type: "error", text: "所选文档中未找到相关实体" });
        return;
      }
      setExportData(result.subgraph);
      const hitText = `命中种子: ${result.seeds.map((s) => s.name).join("、") || "无"}`;
      setNotice({ type: "success", text: hitText });
    } catch (reason) {
      if (currentRequest !== requestId.current) return;
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      if (currentRequest === requestId.current) setBusy(null);
    }
  };

  const expandEntity = async (entityId: string) => {
    if (!source) return;
    const currentRequest = ++requestId.current;
    setBusy("expand");
    setSelectedRelation(null);
    try {
      const neighbors = await neighborsOf(entityId, 2, source);
      if (currentRequest !== requestId.current) return;
      setSelected(entities.find((entity) => entity.id === entityId) ?? null);
      setExportData((current) => mergeExport(current, neighbors));
    } catch (reason) {
      if (currentRequest !== requestId.current) return;
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      if (currentRequest === requestId.current) setBusy(null);
    }
  };

  const selectRelation = (edgeId: string, sourceName: string, targetName: string) => {
    const edge = exportData?.edges.find((item) => item.id === edgeId);
    if (!edge) return;
    setSelected(null);
    setSelectedRelation({ edge, sourceName, targetName });
  };

  const stats = exportData?.stats ?? null;

  return (
    <StudioPage
      eyebrow="上下文工程 / 知识图谱"
      title="知识图谱"
      description="先选择文档，查看该文档的完整实体与关系，再在文档范围内检索子图。"
      actions={
        <>
          <Badge status="success" text="GraphRAG" />
          <Button
            icon={<ReloadOutlined spin={busy === "list"} />}
            onClick={() => {
              setNotice(null);
              void refreshDocument();
              void refreshDocuments();
              void refreshSync();
            }}
          >
            刷新
          </Button>
        </>
      }
      extra={<StudioNotice notice={notice} />}
    >
      <Flex vertical gap={12} style={{ flex: 1, minHeight: 0, padding: 16, overflowY: "auto" }}>
        <GraphSyncBar
          status={sync}
          syncing={syncing}
          lastUsage={buildUsage}
          onReconcile={() => void handleReconcile()}
        />
        <Card size="small">
          <Flex vertical gap={8} style={{ marginBottom: 12 }}>
            <Typography.Text strong>选择文档</Typography.Text>
            <Select
              aria-label="图谱文档"
              value={source}
              placeholder="请先选择文档"
              allowClear
              showSearch
              optionFilterProp="label"
              loading={documentsLoading}
              options={documents.map((document) => ({
                value: document.source,
                label: document.title && document.title !== document.source
                  ? `${document.title} · ${document.source}`
                  : document.source,
              }))}
              notFoundContent={documentsLoading ? <Spin size="small" /> : "暂无文档，请先上传文档"}
              onChange={(nextSource: string | undefined) => {
                requestId.current += 1;
                setSource(nextSource);
                setQuery("");
                setNotice(null);
                setDocumentData(null);
                setExportData(null);
                setSelected(null);
                setSelectedRelation(null);
                setUsage(undefined);
                setBusy(null);
              }}
            />
          </Flex>
          <Flex gap={8} align="center" wrap>
            <Input.Search
              aria-label="子图检索"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onSearch={() => void runSearch()}
              placeholder={source ? "在当前文档内搜索实体或问题" : "请先选择文档"}
              disabled={!source || !documentData || busy !== null}
              loading={busy === "search"}
              enterButton="子图检索"
              style={{ flex: "1 1 240px" }}
            />
            <Button
              disabled={!documentData || busy !== null}
              onClick={() => {
                requestId.current += 1;
                setQuery("");
                setUsage(undefined);
                setSelected(null);
                setSelectedRelation(null);
                setNotice(null);
                setExportData(documentData);
              }}
            >
              显示完整图谱
            </Button>
          </Flex>
          {usage ? (
            <Typography.Text type="secondary" style={{ display: "block", marginTop: 8, fontSize: 12 }}>
              <UsageTag usage={usage} />
            </Typography.Text>
          ) : null}
        </Card>

        <Flex gap={12} align="flex-start" wrap style={{ flex: "1 1 auto", minHeight: 480 }}>
          <Card
            size="small"
            title="实体索引"
            extra={<Tag>{entities.length}</Tag>}
            style={{ width: 280, maxWidth: "100%", flex: "0 0 auto", maxHeight: 560, overflow: "hidden", display: "flex", flexDirection: "column" }}
            styles={{ body: { padding: 8, minHeight: 0, overflowY: "auto" } }}
          >
            {busy === "list" ? (
              <Flex justify="center" style={{ padding: 24 }}>
                <Spin aria-label="正在加载实体" />
              </Flex>
            ) : entities.length === 0 ? (
              <Empty description={source ? "该文档暂无实体，请等待建图或同步图谱" : "请先选择文档"} />
            ) : (
              <List
                size="small"
                dataSource={entities}
                rowKey="id"
                renderItem={(entity) => {
                  const color = colorFor(entity.type);
                  return (
                    <List.Item
                      onClick={() => {
                        setQuery(entity.name);
                        void runSearch(entity.name);
                      }}
                      style={{ cursor: "pointer", borderRadius: 8, padding: "6px 8px" }}
                    >
                      <List.Item.Meta
                        avatar={<Badge color={color.stroke} />}
                        title={<Typography.Text strong ellipsis style={{ maxWidth: 130 }}>{entity.name}</Typography.Text>}
                        description={entity.type}
                      />
                    </List.Item>
                  );
                }}
              />
            )}
          </Card>

          <Card
            size="small"
            title={
              <Flex gap={8} align="center" justify="space-between" wrap>
                <Flex gap={8} align="center">
                  <ApartmentOutlined />
                  <Typography.Text strong>
                    图谱 {stats ? `${stats.entities} 实体 · ${stats.relations} 关系` : source ? "暂无数据" : "未选择文档"}
                  </Typography.Text>
                </Flex>
                <Flex gap={4} wrap>
                  {Object.keys(TYPE_COLORS).map((type) => (
                    <Tag key={type} color="default">
                      {type}
                    </Tag>
                  ))}
                </Flex>
              </Flex>
            }
            style={{ flex: "1 1 320px", minWidth: "min(320px, 100%)", minHeight: 480, display: "flex", flexDirection: "column" }}
            styles={{ body: { flex: 1, minHeight: 420, padding: 8, display: "flex", flexDirection: "column" } }}
          >
            <div style={{ flex: 1, minHeight: 420 }}>
              {exportData?.nodes.length ? <GraphCanvas
                data={exportData}
                selectedEdgeId={selectedRelation?.edge.id ?? null}
                onNodeClick={(id) => void expandEntity(id)}
                onEdgeClick={selectRelation}
                onPaneClick={() => setSelectedRelation(null)}
              /> : (
                <Flex align="center" justify="center" style={{ minHeight: 420 }}>
                  {busy === "list" ? <Spin aria-label="正在加载文档图谱" /> : (
                    <Empty description={!source ? "请先选择文档，查看其实体与关系" : "当前图谱暂无实体"} />
                  )}
                </Flex>
              )}
            </div>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: "8px 0 0" }}>
              点击节点展开 2 跳邻域；点击连线查看关系；拖拽节点调整布局。
            </Typography.Paragraph>
          </Card>

          <Card
            size="small"
            title={selectedRelation ? "关系详情" : "实体详情"}
            style={{ width: 300, maxWidth: "100%", flex: "0 0 auto", maxHeight: "100%", overflowY: "auto" }}
          >
            {selectedRelation ? (
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="起点">{selectedRelation.sourceName}</Descriptions.Item>
                <Descriptions.Item label="关系">{selectedRelation.edge.relType}</Descriptions.Item>
                <Descriptions.Item label="终点">{selectedRelation.targetName}</Descriptions.Item>
                <Descriptions.Item label="权重">{selectedRelation.edge.weight}</Descriptions.Item>
              </Descriptions>
            ) : selected ? (
              <Flex vertical gap={8}>
                <Typography.Title level={5} style={{ margin: 0 }}>{selected.name}</Typography.Title>
                <Tag style={{ alignSelf: "flex-start" }}>{selected.type}</Tag>
                {Object.keys(selected.props ?? {}).length > 0 ? (
                  <Descriptions size="small" column={1} bordered>
                    {Object.entries(selected.props).map(([key, value]) => (
                      <Descriptions.Item key={key} label={key}>{value}</Descriptions.Item>
                    ))}
                  </Descriptions>
                ) : (
                  <Empty description="该实体暂无附加属性（规则抽取通常无 props）。" />
                )}
              </Flex>
            ) : (
              <Empty description="点击图中节点或连线查看详情" />
            )}
            {relTypes.length > 0 ? (
              <Card size="small" type="inner" title="关系分布" style={{ marginTop: 12 }}>
                <List
                  size="small"
                  dataSource={relTypes}
                  rowKey="relType"
                  renderItem={(item) => (
                    <List.Item extra={<Tag>{item.count}</Tag>}>
                      <Typography.Text>{item.relType}</Typography.Text>
                    </List.Item>
                  )}
                />
              </Card>
            ) : null}
          </Card>
        </Flex>
      </Flex>
    </StudioPage>
  );
}

export function GraphWorkspaceWithProvider() {
  return (
    <ReactFlowProvider>
      <GraphWorkspace />
    </ReactFlowProvider>
  );
}
