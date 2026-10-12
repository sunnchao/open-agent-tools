import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type Node,
  type NodeProps,
  type NodeTypes,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AuditOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  TableOutlined,
} from "../../lib/icons.js";
import {
  edgeIdsInSet,
  fetchObservatoryGraph,
  fetchSchemaSources,
  pendingQuerySteps,
  rebuildObservatoryGraph,
  runObservatoryQuery,
  walkChain,
  type GraphExport,
  type HistoryTurn,
  type ObservatoryQueryResult,
  type ObservatoryTable,
  type SchemaSourceOption,
  type QueryStep,
} from "./api.js";
import { QueryExecution, formatDuration } from "./QueryExecution.js";
import { QueryAuditView } from "./QueryAuditView.js";
import { RelationEdge } from "../graph/RelationEdge.js";
import {
  parallelCurveOffsets,
  RELATION_PORTS,
  relationPortsForNodes,
  rerouteRelationEdges,
  type RelationFlowEdge,
} from "../graph/relationRouting.js";

const EXAMPLES = [
  "最近消费日志最多的模型是哪些？",
  "启用状态的用户有多少？",
  "查看渠道列表和权重",
  "本月额度消耗前 10 的用户",
  "有哪些兑换码还没用",
];

interface TableNodeData extends Record<string, unknown> {
  name: string;
  hot: boolean;
  dimmed: boolean;
}

type TableFlowNode = Node<TableNodeData, "tableNode">;
type SchemaEdge = RelationFlowEdge;

function TableNodeView({ data }: NodeProps<TableFlowNode>) {
  return (
    <div className={`obs-node${data.hot ? " is-hot" : ""}${data.dimmed ? " is-dim" : ""}`}>
      <strong>{data.name}</strong>
      <span>table</span>
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

const nodeTypes: NodeTypes = { tableNode: TableNodeView };
const edgeTypes = { relation: RelationEdge };

function layoutNodes(exportData: GraphExport, hotNames: Set<string>): TableFlowNode[] {
  const degrees = new Map(exportData.nodes.map((node) => [node.id, 0]));
  for (const edge of exportData.edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
  }
  const ordered = [...exportData.nodes].sort(
    (left, right) =>
      (degrees.get(right.id) ?? 0) - (degrees.get(left.id) ?? 0) ||
      left.name.localeCompare(right.name),
  );
  return ordered.map((node, index) => {
    const isHub = index === 0;
    const ringIndex = index - 1;
    const ringNumber = Math.max(0, Math.floor(ringIndex / 10));
    const indexInRing = Math.max(0, ringIndex % 10);
    const countInRing = Math.min(10, Math.max(1, ordered.length - 1 - ringNumber * 10));
    const angle = (indexInRing / countInRing) * Math.PI * 2 - Math.PI / 2 + ringNumber * 0.16;
    const radius = 160 + ringNumber * 120;
    return {
      id: `node-${node.id}`,
      type: "tableNode",
      position: isHub
        ? { x: 300, y: 220 }
        : {
            x: 300 + Math.cos(angle) * radius,
            y: 220 + Math.sin(angle) * radius,
          },
      data: {
        name: node.name,
        hot: hotNames.has(node.name),
        dimmed: hotNames.size > 0 && !hotNames.has(node.name),
      },
    };
  });
}

function layoutEdges(
  exportData: GraphExport,
  nodes: TableFlowNode[],
  hotEdgeIds: Set<string>,
  selectedEdgeId: string | null,
): SchemaEdge[] {
  const dimmed = hotEdgeIds.size > 0 || Boolean(selectedEdgeId);
  const offsets = parallelCurveOffsets(exportData.edges);
  return exportData.edges.map((edge) => {
    const selected = edge.id === selectedEdgeId;
    const hot = selected || hotEdgeIds.has(edge.id);
    const source = `node-${edge.source}`;
    const target = `node-${edge.target}`;
    const ports = relationPortsForNodes(source, target, nodes);
    return {
      id: `edge-${edge.id}`,
      source,
      target,
      sourceHandle: ports.sourceHandle,
      targetHandle: ports.targetHandle,
      type: "relation",
      label: edge.relType,
      data: {
        relType: edge.relType,
        rawId: edge.id,
        curveOffset: offsets.get(edge.id) ?? 0,
        showLabel: exportData.edges.length <= 24 || selected || (hot && hotEdgeIds.size <= 12),
      },
      interactionWidth: 24,
      style: {
        stroke: selected ? "#854F0B" : hot ? "#d9822b" : dimmed ? "#c8c4ba" : "#8a8680",
        strokeWidth: selected ? 2.4 : hot ? 1.8 : 1.4,
      },
      labelStyle: {
        fontSize: 10,
        color: selected || hot ? "#854F0B" : dimmed ? "#9a9ea5" : "#6b7077",
        fontWeight: selected || hot ? 600 : 500,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: selected ? "#854F0B" : hot ? "#d9822b" : "#8a8680",
      },
    };
  });
}

function SchemaCanvas({
  data,
  hotNames,
  hotEdgeIds,
  selectedEdgeId,
  onNodeClick,
  onEdgeClick,
  onPaneClick,
}: {
  data: GraphExport | null;
  hotNames: Set<string>;
  hotEdgeIds: Set<string>;
  selectedEdgeId: string | null;
  onNodeClick: (name: string) => void;
  onEdgeClick: (edgeId: string, sourceName: string, targetName: string, relType: string) => void;
  onPaneClick: () => void;
}) {
  const [nodes, setNodes] = useState<TableFlowNode[]>([]);
  const [edges, setEdges] = useState<SchemaEdge[]>([]);

  useEffect(() => {
    if (!data) {
      setNodes([]);
      setEdges([]);
      return;
    }
    const nextNodes = layoutNodes(data, new Set());
    setNodes(nextNodes);
    setEdges(layoutEdges(data, nextNodes, new Set(), null));
  }, [data]);

  useEffect(() => {
    setNodes((current) =>
      current.map((node) => ({
        ...node,
        data: {
          ...node.data,
          hot: hotNames.has(node.data.name),
          dimmed: hotNames.size > 0 && !hotNames.has(node.data.name),
        },
      })),
    );
    setEdges((current) =>
      current.map((edge) => {
        const selected = edge.data?.rawId === selectedEdgeId;
        const hot = selected || hotEdgeIds.has(edge.data?.rawId ?? "");
        const dimmed = hotEdgeIds.size > 0 || Boolean(selectedEdgeId);
        const color = selected ? "#854F0B" : hot ? "#d9822b" : dimmed ? "#c8c4ba" : "#8a8680";
        return {
          ...edge,
          data: edge.data
            ? {
                ...edge.data,
                showLabel: current.length <= 24 || selected || (hot && hotEdgeIds.size <= 12),
              }
            : {
                relType: String(edge.label ?? ""),
                rawId: edge.id.replace(/^edge-/, ""),
                curveOffset: 0,
                showLabel: current.length <= 24,
              },
          style: {
            ...edge.style,
            stroke: color,
            strokeWidth: selected ? 2.4 : hot ? 1.8 : 1.4,
          },
          labelStyle: {
            fontSize: 10,
            color: selected || hot ? "#854F0B" : dimmed ? "#9a9ea5" : "#6b7077",
            fontWeight: selected || hot ? 600 : 500,
          },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
        };
      }),
    );
  }, [data, hotNames, hotEdgeIds, selectedEdgeId]);

  useEffect(() => {
    setEdges((current) => rerouteRelationEdges(current, nodes));
  }, [nodes]);

  const onNodesChange = useCallback<OnNodesChange<TableFlowNode>>(
    (changes) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );
  const onEdgesChange = useCallback<OnEdgesChange<SchemaEdge>>(
    (changes) => setEdges((current) => applyEdgeChanges(changes, current)),
    [],
  );

  const nodeByFlowId = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of nodes) map.set(node.id, node.data.name);
    return map;
  }, [nodes]);

  return (
    <div className="obs-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_event, node) => onNodeClick(node.data.name)}
        onEdgeClick={(_event, edge) => {
          const sourceName = nodeByFlowId.get(edge.source) ?? "";
          const targetName = nodeByFlowId.get(edge.target) ?? "";
          onEdgeClick(
            edge.data?.rawId ?? edge.id.replace(/^edge-/, ""),
            sourceName,
            targetName,
            edge.data?.relType ?? "",
          );
        }}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable
        elementsSelectable
        edgesFocusable
        connectionMode={ConnectionMode.Loose}
        minZoom={0.25}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function formatColumns(table: ObservatoryTable | undefined, limit = 8): string {
  if (!table) return "";
  const cols = table.columns.slice(0, limit).map((column) => column.name);
  const more = table.columns.length > limit ? " …" : "";
  return `${cols.join(" · ")}${more}`;
}

export function ObservatoryWorkspace() {
  const [payload, setPayload] = useState<Awaited<ReturnType<typeof fetchObservatoryGraph>> | null>(
    null,
  );
  const [question, setQuestion] = useState("");
  const [clarify, setClarify] = useState("");
  const [history, setHistory] = useState<HistoryTurn[]>([]);
  const [result, setResult] = useState<ObservatoryQueryResult | null>(null);
  const [busy, setBusy] = useState<"load" | "query" | "rebuild" | null>("load");
  const [notice, setNotice] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [hotNames, setHotNames] = useState<Set<string>>(new Set());
  const [hotEdgeIds, setHotEdgeIds] = useState<Set<string>>(new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [chainTitle, setChainTitle] = useState("点击连线或表名，查看引用链");
  const [chainRef, setChainRef] = useState("");
  const [sources, setSources] = useState<SchemaSourceOption[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [view, setView] = useState<"query" | "audit">("query");
  const [steps, setSteps] = useState<QueryStep[]>(pendingQuerySteps);
  const [auditId, setAuditId] = useState<string>();
  const [liveSql, setLiveSql] = useState("");
  const [liveSchema, setLiveSchema] = useState("");
  const queryController = useRef<AbortController | null>(null);

  useEffect(() => () => queryController.current?.abort(), []);

  const tables = useMemo(() => {
    const map = new Map<string, ObservatoryTable>();
    for (const table of payload?.tables ?? []) map.set(table.name, table);
    return map;
  }, [payload]);

  const activeSource = useMemo(
    () => sources.find((source) => source.id === selectedSourceId) ?? null,
    [selectedSourceId, sources],
  );

  const refresh = useCallback(async (sourceId: string) => {
    if (!sourceId) return;
    setBusy("load");
    try {
      const next = await fetchObservatoryGraph(sourceId);
      setPayload(next);
      setNotice(null);
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setBusy("load");
      try {
        const available = await fetchSchemaSources();
        setSources(available);
        const remembered = localStorage.getItem("open-agent-tools.observatory-source");
        const selected =
          available.find((source) => source.id === remembered) ??
          available.find((source) => source.isDefault) ??
          available[0];
        if (!selected) {
          setNotice({ type: "error", text: "尚未配置可用 Schema 数据源" });
          setBusy(null);
          return;
        }
        setSelectedSourceId(selected.id);
        await refresh(selected.id);
      } catch (reason) {
        setNotice({
          type: "error",
          text: reason instanceof Error ? reason.message : String(reason),
        });
        setBusy(null);
      }
    })();
  }, [refresh]);

  const selectSource = (sourceId: string) => {
    setSelectedSourceId(sourceId);
    setPayload(null);
    localStorage.setItem("open-agent-tools.observatory-source", sourceId);
    setResult(null);
    setSteps(pendingQuerySteps());
    setAuditId(undefined);
    setLiveSql("");
    setLiveSchema("");
    setHistory([]);
    setHotNames(new Set());
    setHotEdgeIds(new Set());
    setSelectedEdgeId(null);
    setChainTitle("点击连线或表名，查看引用链");
    setChainRef("");
    void refresh(sourceId);
  };

  const applyChain = (names: Set<string>, edgeIds: Set<string>, title: string, ref = "") => {
    setHotNames(names);
    setHotEdgeIds(edgeIds);
    setChainTitle(title);
    setChainRef(ref);
  };

  const selectEdge = (edgeId: string, sourceName: string, targetName: string, relType: string) => {
    if (!payload) return;
    const names = walkChain(payload.graph.edges, payload.graph.nodes, [sourceName, targetName], 2);
    applyChain(
      names,
      edgeIdsInSet(payload.graph.edges, payload.graph.nodes, names),
      "引用链",
      `${sourceName}.${relType || "ref"} → ${targetName}`,
    );
    setSelectedEdgeId(edgeId);
  };

  const selectNode = (name: string) => {
    if (!payload) return;
    const names = walkChain(payload.graph.edges, payload.graph.nodes, [name], 1);
    applyChain(names, edgeIdsInSet(payload.graph.edges, payload.graph.nodes, names), `表 ${name}`);
    setSelectedEdgeId(null);
  };

  const clearSelection = () => {
    const selected = new Set(result?.selectedTables ?? []);
    setHotNames(selected);
    setHotEdgeIds(
      payload ? edgeIdsInSet(payload.graph.edges, payload.graph.nodes, selected) : new Set(),
    );
    setSelectedEdgeId(null);
    setChainTitle("点击连线或表名，查看引用链");
    setChainRef("");
  };

  const runQuery = async (text: string, fromClarify = false) => {
    const trimmed = text.trim();
    if (!trimmed || !selectedSourceId || busy || queryController.current) return;
    const controller = new AbortController();
    queryController.current = controller;
    setBusy("query");
    setNotice(null);
    setResult(null);
    setSteps(pendingQuerySteps());
    setAuditId(undefined);
    setLiveSql("");
    setLiveSchema("");
    setHotNames(new Set());
    setHotEdgeIds(new Set());
    setSelectedEdgeId(null);
    setChainTitle("查询执行中");
    setChainRef("");
    try {
      const nextHistory = fromClarify ? history : [];
      const next = await runObservatoryQuery(
        selectedSourceId,
        trimmed,
        nextHistory,
        (event) => {
          if (controller.signal.aborted) return;
          setAuditId(event.auditId);
          if (event.type === "start") {
            setSteps(event.steps);
          } else {
            setSteps((current) =>
              current.map((step) => (step.id === event.step.id ? event.step : step)),
            );
            if (event.step.id === "generation" && typeof event.step.output?.sql === "string") {
              setLiveSql(event.step.output.sql);
            }
            if (event.step.id === "retrieval" && event.step.status === "succeeded") {
              if (typeof event.step.output?.schemaPrompt === "string") {
                setLiveSchema(event.step.output.schemaPrompt);
              }
              const names = new Set(
                Array.isArray(event.step.output?.selectedTables)
                  ? event.step.output.selectedTables.filter(
                      (name): name is string => typeof name === "string",
                    )
                  : [],
              );
              setHotNames(names);
              setHotEdgeIds(
                payload ? edgeIdsInSet(payload.graph.edges, payload.graph.nodes, names) : new Set(),
              );
            }
          }
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setResult(next);
      if (next.steps) setSteps(next.steps);
      setAuditId(next.auditId);
      setChainTitle(
        next.error ? "查询失败" : next.clarifying ? "等待补充查询口径" : "本次查询相关表",
      );
      const selected = new Set(next.selectedTables);
      setHotNames(selected);
      setHotEdgeIds(
        payload ? edgeIdsInSet(payload.graph.edges, payload.graph.nodes, selected) : new Set(),
      );
      setSelectedEdgeId(null);
      if (next.clarifying) {
        setHistory([
          ...nextHistory,
          { role: "user", content: trimmed },
          { role: "assistant", content: next.clarifying },
        ]);
        setClarify("");
      } else {
        setHistory([]);
        setClarify("");
      }
    } catch (reason) {
      if (controller.signal.aborted) return;
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
      setSteps((current) =>
        current.map((step) =>
          step.status === "running" || step.status === "pending"
            ? { ...step, status: "skipped", message: "连接中断，请通过审计日志确认执行状态" }
            : step,
        ),
      );
    } finally {
      queryController.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  };

  const rebuild = async () => {
    if (!selectedSourceId) return;
    setBusy("rebuild");
    setNotice(null);
    try {
      await rebuildObservatoryGraph(selectedSourceId);
      await refresh(selectedSourceId);
      setNotice({ type: "success", text: "图谱已重建" });
    } catch (reason) {
      setNotice({ type: "error", text: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      setBusy(null);
    }
  };

  const chainNames = [...hotNames];
  const rows = result?.rows ?? [];
  const schemaText =
    result?.schemaPrompt ||
    liveSchema ||
    chainNames
      .map((name) => {
        const table = tables.get(name);
        if (!table) return `### ${name}`;
        const cols = table.columns
          .map(
            (column) =>
              `  - \`${column.name}\` ${column.type}${column.comment ? ` -- ${column.comment}` : ""}`,
          )
          .join("\n");
        return `### \`${name}\`${table.comment ? ` -- ${table.comment}` : ""}\n${cols}`;
      })
      .join("\n\n");

  return (
    <section className="domain-workspace observatory-workspace">
      <header className="domain-header">
        <div>
          <p className="domain-eyebrow">Text-to-SQL / Schema GraphRAG</p>
          <h1>Schema Observatory</h1>
        </div>
        <div className="domain-header-actions">
          <label className="obs-source-selector">
            <TableOutlined />
            <select
              aria-label="Schema 数据源"
              value={selectedSourceId}
              onChange={(event) => selectSource(event.target.value)}
              disabled={sources.length === 0 || busy !== null}
            >
              {sources.length === 0 ? <option value="">未配置数据源</option> : null}
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                  {source.isDefault ? " · 默认" : ""}
                </option>
              ))}
            </select>
          </label>
          <button
            className="studio-button secondary"
            type="button"
            title="管理 Schema 数据源"
            onClick={() => {
              sessionStorage.setItem("open-agent-tools.settings-section", "schema-sources");
              window.location.hash = "settings";
            }}
          >
            <SettingOutlined /> 管理
          </button>
          <button
            className="studio-button secondary"
            type="button"
            disabled={!selectedSourceId || busy !== null}
            onClick={() => void refresh(selectedSourceId)}
          >
            <ReloadOutlined /> 刷新
          </button>
          <button
            className="studio-button secondary"
            type="button"
            disabled={!selectedSourceId || busy !== null}
            onClick={() => void rebuild()}
          >
            {busy === "rebuild" ? "重建中..." : "重建图谱"}
          </button>
        </div>
      </header>

      {notice ? (
        <div className={`workspace-notice ${notice.type}`} role="status">
          {notice.text}
        </div>
      ) : null}

      <nav className="obs-view-tabs" aria-label="问数视图">
        <button
          type="button"
          className={view === "query" ? "is-active" : ""}
          aria-pressed={view === "query"}
          onClick={() => setView("query")}
        >
          <SearchOutlined /> 数据问数
        </button>
        <button
          type="button"
          className={view === "audit" ? "is-active" : ""}
          aria-pressed={view === "audit"}
          onClick={() => setView("audit")}
        >
          <AuditOutlined /> 审计日志
        </button>
      </nav>

      {view === "audit" ? (
        <QueryAuditView
          key={`${selectedSourceId}:${result?.auditId ?? ""}`}
          sourceId={selectedSourceId}
        />
      ) : (
        <div className="graph-layout obs-layout">
          <aside className="graph-side-panel">
            <div className="panel-heading">
              <span>问运营数据</span>
            </div>
            <div className="obs-ask">
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="例如：最近消费日志最多的模型是哪些？"
              />
              <button
                className="studio-button primary"
                type="button"
                disabled={!selectedSourceId || !question.trim() || busy !== null}
                onClick={() => void runQuery(question)}
              >
                <SearchOutlined /> {busy === "query" ? "执行中..." : "生成并执行 SQL"}
              </button>
              {activeSource?.semanticProfile === "oneapi" ? (
                <div className="obs-chips">
                  {EXAMPLES.map((item) => (
                    <button
                      key={item}
                      className="obs-chip"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => {
                        setQuestion(item);
                        void runQuery(item);
                      }}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="obs-stat">
                {payload ? (
                  <>
                    <b>{activeSource?.name ?? payload.database}</b>
                    <span>
                      {payload.database} · {payload.tables.length} 张表 ·{" "}
                      {payload.graph.stats.relations} 条引用
                    </span>
                  </>
                ) : (
                  <span>{busy === "load" ? "正在加载图谱..." : "未加载"}</span>
                )}
              </div>
              <div className="obs-execution-heading">
                <strong>执行过程</strong>
                {result ? <span>{formatDuration(result.durationMs)}</span> : null}
              </div>
              <QueryExecution steps={steps} auditId={auditId} />
              <div className="obs-chain">
                <strong>{chainTitle}</strong>
                {chainRef ? <div className="obs-ref">{chainRef}</div> : null}
                {chainNames.length > 0 ? (
                  <ul>
                    {chainNames.map((name) => {
                      const table = tables.get(name);
                      return (
                        <li key={name}>
                          <b>{name}</b>
                          {table ? ` · ~${table.rows} 行` : ""}
                          <div>{formatColumns(table)}</div>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p>点击连线高亮 2 跳引用链，并列出相关表字段。</p>
                )}
              </div>
            </div>
          </aside>

          <div className="graph-canvas-panel">
            <div className="graph-canvas-heading">
              <span>
                <TableOutlined /> schema 图
              </span>
              <span className="graph-legend">
                <span className="graph-legend-item">
                  <span className="graph-legend-dot" style={{ background: "#d9822b" }} />
                  当前链
                </span>
              </span>
            </div>
            <SchemaCanvas
              data={payload?.graph ?? null}
              hotNames={hotNames}
              hotEdgeIds={hotEdgeIds}
              selectedEdgeId={selectedEdgeId}
              onNodeClick={selectNode}
              onEdgeClick={selectEdge}
              onPaneClick={clearSelection}
            />
            <div className="graph-canvas-hint">
              点击连线高亮引用链；点击空白取消；拖拽节点调整布局。
            </div>
          </div>

          <aside className="graph-inspector obs-inspector">
            <div className="panel-heading">
              <span>Selected schema</span>
            </div>
            <pre className="obs-pre">{schemaText || "提问或点选引用链后显示相关表字段"}</pre>
            <div className="panel-heading">
              <span>SQL</span>
            </div>
            <pre className="obs-pre obs-sql">
              {result?.sql ?? (liveSql || result?.clarifying || result?.error || "等待生成")}
            </pre>
            <div className="panel-heading">
              <span>Result</span>
            </div>
            <div className="obs-result">
              {result?.error ? <div className="workspace-notice error">{result.error}</div> : null}
              {result?.clarifying ? <p>{result.clarifying}</p> : null}
              {result?.truncated ? (
                <p className="panel-state">仅展示前 {rows.length} 条，已达安全上限。可缩小范围后重试。</p>
              ) : null}
              {rows.length > 0 ? (
                <div className="obs-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {Object.keys(rows[0] ?? {}).map((key) => (
                          <th key={key}>{key}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, index) => (
                        <tr key={index}>
                          {Object.keys(rows[0] ?? {}).map((key) => (
                            <td key={key}>{String(row[key] ?? "")}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {!result ? (
                <p className="panel-state">
                  {busy === "query" ? "查询执行中，完成后显示结果" : "指定条数后返回对应结果；未指定时会先确认"}
                </p>
              ) : null}
              {result?.clarifying ? (
                <div className="obs-clarify">
                  <label htmlFor="obs-clarify">回答追问后继续生成 SQL</label>
                  <textarea
                    id="obs-clarify"
                    value={clarify}
                    onChange={(event) => setClarify(event.target.value)}
                    placeholder="例如：渠道表的 weight 字段"
                  />
                  <div className="obs-clarify-actions">
                    <button
                      className="studio-button primary"
                      type="button"
                      disabled={!clarify.trim() || busy !== null}
                      onClick={() => void runQuery(clarify, true)}
                    >
                      继续查询
                    </button>
                    <button
                      className="studio-button secondary"
                      type="button"
                      onClick={() => {
                        setHistory([]);
                        setClarify("");
                      }}
                    >
                      新问题
                    </button>
                  </div>
                </div>
              ) : null}
              {result && rows.length === 0 && !result.clarifying && !result.error ? (
                <p className="panel-state">无数据</p>
              ) : null}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}

export function ObservatoryWorkspaceWithProvider() {
  return (
    <ReactFlowProvider>
      <ObservatoryWorkspace />
    </ReactFlowProvider>
  );
}
