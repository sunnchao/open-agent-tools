import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Flex,
  Input,
  List,
  Select,
  Segmented,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
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
  BranchesOutlined,
  ReloadOutlined,
  SearchOutlined,
  SettingOutlined,
  TableOutlined,
} from "../../lib/icons.js";
import { StudioPage } from "../../components/studio/StudioPageHeader.js";
import { StudioNotice, type StudioNoticeValue } from "../../components/studio/StudioNotice.js";
import {
  edgeIdsInSet,
  fetchObservatoryGraph,
  fetchSchemaSources,
  pendingQuerySteps,
  rebuildObservatoryGraph,
  rerunObservatoryQuery,
  runObservatoryQuery,
  walkChain,
  type GraphExport,
  type HistoryTurn,
  type ObservatoryQueryResult,
  type ObservatoryTable,
  type SchemaSourceOption,
  type QueryStep,
  type Clarification,
} from "./api.js";
import { appendTurn, assistantSummary, carriedUserTurns } from "./followUp.js";
import { QueryExecution, formatDuration } from "./QueryExecution.js";
import { UsageTag } from "../../components/UsageTag.js";
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
  const { message } = App.useApp();
  const [payload, setPayload] = useState<Awaited<ReturnType<typeof fetchObservatoryGraph>> | null>(
    null,
  );
  const [question, setQuestion] = useState("");
  const [clarify, setClarify] = useState("");
  const [history, setHistory] = useState<HistoryTurn[]>([]);
  const [result, setResult] = useState<ObservatoryQueryResult | null>(null);
  const [busy, setBusy] = useState<"load" | "query" | "rebuild" | null>("load");
  const [notice, setNotice] = useState<StudioNoticeValue | null>(null);
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
  const [sqlDraft, setSqlDraft] = useState("");
  const [activeClarification, setActiveClarification] = useState<Clarification | null>(null);
  const [originalQuestion, setOriginalQuestion] = useState("");
  const [activeParentAuditId, setActiveParentAuditId] = useState("");
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
    setSqlDraft("");
    setActiveClarification(null);
    setOriginalQuestion("");
    setActiveParentAuditId("");
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

  // 开一个新的追问线程:清掉上下文与澄清状态,下一次提问从零开始。
  const resetThread = () => {
    setHistory([]);
    setOriginalQuestion("");
    setActiveClarification(null);
    setClarify("");
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
    setSqlDraft("");
    setLiveSchema("");
    setHotNames(new Set());
    setHotEdgeIds(new Set());
    setSelectedEdgeId(null);
    setChainTitle("查询执行中");
    setChainRef("");
    try {
      // C7 多轮追问:同一线程内始终带上上下文,指代型追问(「那 3 月呢」)才能接得上。
      const nextHistory = history;
      const nextOriginalQuestion = fromClarify
        ? originalQuestion || activeClarification?.originalQuestion || text
        : originalQuestion || text;
      const next = await runObservatoryQuery(
        selectedSourceId,
        trimmed,
        nextHistory,
        (event) => {
          if (controller.signal.aborted) return;
          setAuditId(event.auditId);
          if (event.type === "start") {
            setSteps(event.steps);
          } else if (event.type === "clarification") {
            setActiveClarification(event.clarification);
          } else {
            setSteps((current) =>
              current.map((step) => (step.id === event.step.id ? event.step : step)),
            );
            if (event.step.id === "generation" && typeof event.step.output?.sql === "string") {
              setLiveSql(event.step.output.sql);
              setSqlDraft(event.step.output.sql);
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
        nextOriginalQuestion,
      );
      if (controller.signal.aborted) return;
      setResult(next);
      if (next.steps) setSteps(next.steps);
      setAuditId(next.auditId);
      setOriginalQuestion(next.originalQuestion || nextOriginalQuestion);
      setActiveParentAuditId(next.auditId ?? "");
      setActiveClarification(next.clarification ?? null);
      setSqlDraft(next.executedSql || next.sql || "");
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
        setHistory((current) => appendTurn(current, trimmed, next.clarifying ?? ""));
        setClarify("");
      } else {
        // 成功的一轮也留在上下文里,后续追问可以在这条 SQL 上改口径。
        setHistory((current) => appendTurn(current, trimmed, assistantSummary(next)));
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

  const rerun = async (sql: string, parentAuditId = auditId) => {
    if (!parentAuditId || !sql.trim() || busy || queryController.current) return;
    const controller = new AbortController();
    queryController.current = controller;
    setBusy("query");
    setNotice(null);
    setSteps(pendingQuerySteps());
    setLiveSql(sql);
    setResult({
      sourceId: selectedSourceId,
      question: originalQuestion || question,
      originalQuestion: originalQuestion || question,
      selectedTables: hotNames.size ? [...hotNames] : [],
      schemaPrompt: liveSchema,
      graph: payload?.graph ?? { nodes: [], edges: [], stats: { entities: 0, relations: 0 } },
      seeds: [],
      formattedGraph: "",
      executedSql: sql,
      generatedSql: result?.generatedSql,
      durationMs: 0,
    });
    setActiveParentAuditId(parentAuditId);
    try {
      const next = await rerunObservatoryQuery(
        parentAuditId,
        sql,
        (event) => {
          if (controller.signal.aborted) return;
          setAuditId(event.auditId);
          if (event.type === "start") {
            setSteps(event.steps);
          } else if (event.type === "clarification") {
            setActiveClarification(event.clarification);
          } else {
            setSteps((current) =>
              current.map((step) => (step.id === event.step.id ? event.step : step)),
            );
            if (event.step.id === "validation") {
              setLiveSql(sql);
              setSqlDraft(sql);
            }
          }
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setResult(next);
      if (next.steps) setSteps(next.steps);
      setAuditId(next.auditId);
      setSqlDraft(next.executedSql || sql);
      setOriginalQuestion(next.originalQuestion ?? originalQuestion);
      setActiveClarification(next.clarification ?? null);
      setChainTitle(next.error ? "重跑失败" : "重跑完成");
      const selected = new Set(next.selectedTables);
      setHotNames(selected);
      setHotEdgeIds(
        payload ? edgeIdsInSet(payload.graph.edges, payload.graph.nodes, selected) : new Set(),
      );
      setNotice({
        type: next.error ? "error" : "success",
        text: next.error ?? "已创建新的审计记录并完成重跑",
      });
    } catch (reason) {
      if (!controller.signal.aborted) {
        setNotice({
          type: "error",
          text: reason instanceof Error ? reason.message : String(reason),
        });
      }
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
      void message.success("图谱已重建");
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

  const resultColumns: ColumnsType<Record<string, unknown>> = (rows[0] ? Object.keys(rows[0]) : []).map((key) => ({
    title: key,
    dataIndex: key,
    key,
    ellipsis: true,
    render: (value: unknown) => String(value ?? ""),
  }));

  return (
    <StudioPage
      eyebrow="Text-to-SQL / Schema GraphRAG"
      title="Schema Observatory"
      description="用自然语言问运营数据，SQL 生成与执行全程留痕可审计。"
      actions={
        <>
          <Select
            aria-label="Schema 数据源"
            value={selectedSourceId || undefined}
            onChange={(value) => selectSource(value)}
            disabled={sources.length === 0 || busy !== null}
            placeholder={sources.length === 0 ? "未配置数据源" : "选择数据源"}
            options={sources.map((source) => ({
              value: source.id,
              label: `${source.name}${source.isDefault ? " · 默认" : ""}`,
            }))}
            style={{ minWidth: 180 }}
          />
          <Tooltip title="管理 Schema 数据源">
            <Button
              icon={<SettingOutlined />}
              onClick={() => {
                sessionStorage.setItem("open-agent-tools.settings-section", "schema-sources");
                window.location.hash = "settings";
              }}
              aria-label="管理 Schema 数据源"
            />
          </Tooltip>
          <Button
            icon={<ReloadOutlined spin={busy === "load"} />}
            disabled={!selectedSourceId || busy !== null}
            onClick={() => void refresh(selectedSourceId)}
          >
            刷新
          </Button>
          <Button
            loading={busy === "rebuild"}
            disabled={!selectedSourceId || busy !== null}
            onClick={() => void rebuild()}
          >
            {busy === "rebuild" ? "重建中..." : "重建图谱"}
          </Button>
        </>
      }
      extra={<StudioNotice notice={notice} />}
    >
      <Flex gap={12} align="flex-start" style={{ flex: 1, minHeight: 0, padding: 16, overflowY: "auto" }}>
        <Flex vertical gap={12} style={{ flex: 1, minWidth: 0 }}>
          <Card size="small">
            <Segmented<"query" | "audit">
              aria-label="问数视图"
              value={view}
              onChange={(value) => setView(value)}
              options={[
                { value: "query", label: "数据问数", icon: <SearchOutlined /> },
                { value: "audit", label: "审计日志" },
              ]}
              block
            />
          </Card>
          {view === "audit" ? (
            <QueryAuditView
              key={`${selectedSourceId}:${result?.auditId ?? ""}`}
              sourceId={selectedSourceId}
            />
          ) : (
            <Flex
              className="studio-split-layout studio-split-layout--nested"
              gap={12}
              align="flex-start"
              style={{ flex: 1, minHeight: 480 }}
            >
              <Card
                className="studio-split-layout__aside"
                size="small"
                title="问运营数据"
                style={{ width: 330, flex: "0 0 auto", maxHeight: "100%", overflowY: "auto" }}
              >
                <Flex vertical gap={8}>
                  <Input.TextArea
                    aria-label="运营问题"
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    placeholder="例如：最近消费日志最多的模型是哪些？"
                    rows={3}
                  />
                  <Button
                    type="primary"
                    icon={<SearchOutlined />}
                    loading={busy === "query"}
                    disabled={!selectedSourceId || !question.trim() || busy !== null}
                    onClick={() => void runQuery(question)}
                    block
                  >
                    {busy === "query" ? "执行中..." : "生成并执行 SQL"}
                  </Button>
                  {carriedUserTurns(history) > 0 ? (
                    <Flex gap={8} align="center" wrap>
                      <Tag icon={<BranchesOutlined />}>
                        追问中 · 已带 {carriedUserTurns(history)} 轮上下文
                      </Tag>
                      <Button size="small" disabled={busy !== null} onClick={resetThread}>
                        新会话
                      </Button>
                    </Flex>
                  ) : (
                    <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                      提问后可继续追问（例如「那 3 月呢」「换成渠道维度」）
                    </Typography.Paragraph>
                  )}
                  {activeSource?.semanticProfile === "oneapi" ? (
                    <Flex gap={4} wrap>
                      {EXAMPLES.map((item) => (
                        <Button
                          key={item}
                          size="small"
                          type="dashed"
                          disabled={busy !== null}
                          onClick={() => {
                            setQuestion(item);
                            void runQuery(item);
                          }}
                        >
                          {item}
                        </Button>
                      ))}
                    </Flex>
                  ) : null}
                  <Card size="small" type="inner" title="当前图谱">
                    {payload ? (
                      <Flex vertical gap={2}>
                        <Typography.Text strong style={{ fontSize: 13 }}>
                          {activeSource?.name ?? payload.database}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {payload.database} · {payload.tables.length} 张表 ·{" "}
                          {payload.graph.stats.relations} 条引用
                        </Typography.Text>
                      </Flex>
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {busy === "load" ? "正在加载图谱..." : "未加载"}
                      </Typography.Text>
                    )}
                  </Card>
                  <Card
                    size="small"
                    type="inner"
                    title="执行过程"
                    extra={result ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{formatDuration(result.durationMs)}</Typography.Text> : undefined}
                  >
                    <QueryExecution steps={steps} auditId={auditId} />
                  </Card>
                  <Card
                    size="small"
                    type="inner"
                    title={chainTitle}
                    extra={chainRef ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{chainRef}</Typography.Text> : undefined}
                  >
                    {chainNames.length > 0 ? (
                      <List
                        size="small"
                        dataSource={chainNames}
                        rowKey={(name: string) => name}
                        renderItem={(name: string) => {
                          const table = tables.get(name);
                          return (
                            <List.Item>
                              <List.Item.Meta
                                title={<Typography.Text strong style={{ fontSize: 13 }}>{name}</Typography.Text>}
                                description={
                                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                    {table ? `~${table.rows} 行` : ""} {formatColumns(table)}
                                  </Typography.Text>
                                }
                              />
                            </List.Item>
                          );
                        }}
                      />
                    ) : (
                      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                        点击连线高亮 2 跳引用链，并列出相关表字段。
                      </Typography.Paragraph>
                    )}
                  </Card>
                </Flex>
              </Card>

              <Card
                className="studio-split-layout__main"
                size="small"
                title={
                  <Flex gap={8} align="center">
                    <TableOutlined />
                    <Typography.Text strong>schema 图</Typography.Text>
                    <Tag>当前链</Tag>
                  </Flex>
                }
                extra={
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                    点击连线高亮引用链；点击空白取消；拖拽节点调整布局。
                  </Typography.Paragraph>
                }
                style={{ flex: 1, minWidth: 0, minHeight: 480, display: "flex", flexDirection: "column" }}
                styles={{ body: { flex: 1, minHeight: 420, padding: 8 } }}
              >
                <div style={{ flex: 1, minHeight: 420 }}>
                  <SchemaCanvas
                    data={payload?.graph ?? null}
                    hotNames={hotNames}
                    hotEdgeIds={hotEdgeIds}
                    selectedEdgeId={selectedEdgeId}
                    onNodeClick={selectNode}
                    onEdgeClick={selectEdge}
                    onPaneClick={clearSelection}
                  />
                </div>
              </Card>

              <Card
                className="studio-split-layout__detail"
                size="small"
                title="Selected schema"
                extra={
                  result?.generatedSql && sqlDraft.trim() !== result.generatedSql.trim() ? (
                    <Tag color="warning">草稿已编辑</Tag>
                  ) : (
                    <Tag>只读校验后执行</Tag>
                  )
                }
                style={{ width: 360, flex: "0 0 auto", maxHeight: "100%", overflowY: "auto" }}
              >
                <Flex vertical gap={12}>
                  <Typography.Paragraph code style={{ fontSize: 12, maxHeight: 160, overflowY: "auto" }}>
                    {schemaText || "提问或点选引用链后显示相关表字段"}
                  </Typography.Paragraph>
                  {result?.clarifying ? (
                    <Alert showIcon type="info" message={result.clarifying} />
                  ) : (
                    <Input.TextArea
                      aria-label="可编辑 SQL"
                      value={sqlDraft || liveSql}
                      onChange={(event) => setSqlDraft(event.target.value)}
                      placeholder="生成 SQL 后可检查并编辑，再创建子审计重跑"
                      spellCheck={false}
                      rows={8}
                      style={{ fontFamily: "monospace", fontSize: 12 }}
                    />
                  )}
                  {activeParentAuditId && !result?.clarifying ? (
                    <Flex vertical gap={8}>
                      <Flex gap={8} wrap>
                        <Button
                          disabled={busy !== null || !liveSql.trim()}
                          onClick={() => {
                            setSqlDraft(liveSql);
                            void rerun(liveSql, activeParentAuditId);
                          }}
                        >
                          原样重跑
                        </Button>
                        <Button
                          type="primary"
                          disabled={busy !== null || !(sqlDraft || liveSql).trim()}
                          onClick={() => void rerun(sqlDraft || liveSql, activeParentAuditId)}
                        >
                          校验并重跑编辑 SQL
                        </Button>
                      </Flex>
                      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                        重跑会创建新的审计记录，父记录保持不变。
                      </Typography.Paragraph>
                    </Flex>
                  ) : null}
                  <Card size="small" type="inner" title="Result" extra={<UsageTag usage={result?.usage} />}>
                    {result?.error ? <Alert showIcon type="error" message={result.error} style={{ marginBottom: 8 }} /> : null}
                    {result?.clarifying ? <Typography.Paragraph>{result.clarifying}</Typography.Paragraph> : null}
                    {result?.truncated ? (
                      <Alert
                        showIcon
                        type="warning"
                        message={`仅展示前 ${rows.length} 条，已达安全上限。可缩小范围后重试。`}
                        style={{ marginBottom: 8 }}
                      />
                    ) : null}
                    {rows.length > 0 ? (
                      <Table
                        size="small"
                        rowKey={(_, index) => String(index)}
                        columns={resultColumns}
                        dataSource={rows}
                        pagination={rows.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
                        scroll={{ x: "max-content", y: 300 }}
                      />
                    ) : null}
                    {!result ? (
                      <Empty
                        description={busy === "query" ? "查询执行中，完成后显示结果" : "指定条数后返回对应结果；未指定时会先确认"}
                      />
                    ) : null}
                    {result?.clarifying ? (
                      <Flex vertical gap={8}>
                        {activeClarification ? (
                          <Card size="small" type="inner" title={`第 ${activeClarification.round} 轮 · 待补充：${activeClarification.slots.map((slot) => slot.label).join("、")}`}>
                            {activeClarification.candidates.length ? (
                              <Flex gap={4} wrap>
                                {activeClarification.candidates.map((candidate) => (
                                  <Tooltip key={`${candidate.label}:${candidate.value}`} title={candidate.description}>
                                    <Button size="small" type="dashed" onClick={() => setClarify(candidate.value)}>
                                      {candidate.label}
                                    </Button>
                                  </Tooltip>
                                ))}
                              </Flex>
                            ) : null}
                          </Card>
                        ) : null}
                        <Input.TextArea
                          aria-label="回答追问后继续生成 SQL"
                          value={clarify}
                          onChange={(event) => setClarify(event.target.value)}
                          placeholder="例如：渠道表的 weight 字段"
                          rows={2}
                        />
                        <Flex gap={8}>
                          <Button
                            type="primary"
                            disabled={!clarify.trim() || busy !== null}
                            onClick={() => void runQuery(clarify, true)}
                          >
                            继续查询
                          </Button>
                          <Button onClick={resetThread}>新问题</Button>
                        </Flex>
                      </Flex>
                    ) : null}
                    {result && rows.length === 0 && !result.clarifying && !result.error ? (
                      <Empty description="无数据" />
                    ) : null}
                  </Card>
                </Flex>
              </Card>
            </Flex>
          )}
        </Flex>
      </Flex>
    </StudioPage>
  );
}

export function ObservatoryWorkspaceWithProvider() {
  return (
    <ReactFlowProvider>
      <ObservatoryWorkspace />
    </ReactFlowProvider>
  );
}
