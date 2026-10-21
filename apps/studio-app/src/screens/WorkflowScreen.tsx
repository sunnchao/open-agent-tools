import React, { useMemo, useState } from "react";
import { View } from "react-native";
import {
  Chip,
  Divider,
  Icon,
  IconButton,
  Surface,
  Text,
  useTheme,
} from "react-native-paper";
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  fetchWorkflow,
  fetchWorkflowRunEvents,
  fetchWorkflowRuns,
  fetchWorkflows,
  publishWorkflow,
  revokeWorkflowKey,
  rollbackWorkflow,
  createWorkflowKey,
  saveWorkflowDraft,
  streamWorkflow,
  testWorkflowNode,
  type WorkflowDetailRecord,
  type WorkflowNode,
  type WorkflowRunRequest,
  type WorkflowSnapshot,
} from "../api/workflow";
import {
  createEdge,
  createNode,
  hydrateWorkflowSnapshot,
  inputOptions,
  migrateNodeData,
  NODE_KINDS,
  outputOptions,
  palette,
  snapshotGraph,
  validateWorkflowGraph,
  type NodeKind,
} from "../api/workflowModel";
import { fetchResourceCatalog } from "../api/misc";
import { useAsync } from "../hooks/useAsync";
import { newId } from "../lib/ids";
import {
  Btn,
  Card,
  ErrorText,
  Field,
  Loading,
  Sub,
} from "../components/ui";
import { WorkspaceScreen } from "../components/workspaceScreen";

function toRunRequest(
  snapshot: WorkflowSnapshot,
  input: Record<string, unknown>,
  workflowId?: string,
): WorkflowRunRequest {
  return {
    ...(workflowId ? { workflowId } : {}),
    nodes: snapshot.nodes.map((n) => ({
      id: n.id,
      kind: String((n.data as { kind?: string }).kind ?? "llm"),
      label: String((n.data as { label?: string }).label ?? n.id),
      config: (n.data as { config?: Record<string, unknown> }).config ?? {},
    })),
    edges: snapshot.edges.map((e) => ({
      id: String(e.id ?? `${e.source}-${e.target}`),
      source: e.source,
      target: e.target,
      ...(typeof e.label === "string" ? { label: e.label } : {}),
      ...(e.branchId ? { branchId: e.branchId } : {}),
    })),
    input,
  };
}

export function WorkflowScreen() {
  const theme = useTheme();
  const list = useAsync(fetchWorkflows);
  const catalog = useAsync(fetchResourceCatalog);
  const [detail, setDetail] = useState<WorkflowDetailRecord | null>(null);
  const [draftName, setDraftName] = useState("未命名工作流");
  const [nodes, setNodes] = useState<WorkflowNode[]>([]);
  const [edges, setEdges] = useState<
    Array<{ id?: string; source: string; target: string; label?: unknown; branchId?: string }>
  >([]);
  const [selectedNode, setSelectedNode] = useState("");
  const [runInput, setRunInput] = useState("{}");
  const [runLog, setRunLog] = useState<string[]>([]);
  const [runOutputs, setRunOutputs] = useState("");
  const [running, setRunning] = useState(false);
  const [name, setName] = useState("");
  const [runs, setRuns] = useState<Array<{ id: string; status: string }>>([]);
  const [keys, setKeys] = useState<
    Array<{ id: string; name: string; prefix: string; status: string }>
  >([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState<{ nodeId: string; text: string } | null>(null);

  const selected = useMemo(
    () => nodes.find((n) => n.id === selectedNode) ?? null,
    [nodes, selectedNode],
  );
  const issues = useMemo(
    () =>
      validateWorkflowGraph(
        nodes.map((n) => ({
          id: n.id,
          data: {
            id: n.id,
            kind: String((n.data as { kind?: string }).kind ?? "llm") as NodeKind,
            label: String((n.data as { label?: string }).label ?? n.id),
            description: "",
            config: (n.data as { config?: Record<string, unknown> }).config ?? {},
          },
        })),
        edges.map((e) => ({
          source: e.source,
          target: e.target,
          label: e.label,
          branchId: e.branchId,
        })),
        catalog.data ?? null,
      ),
    [nodes, edges, catalog.data],
  );

  const open = async (id: string) => {
    setBusy(`open-${id}`);
    setActionError(null);
    try {
      const res = await fetchWorkflow(id);
      setDetail(res.workflow);
      const hydrated = hydrateWorkflowSnapshot(res.workflow.draft);
      setDraftName(hydrated.name);
      setNodes(hydrated.nodes);
      setEdges(hydrated.edges);
      setSelectedNode(hydrated.nodes[0]?.id ?? "");
      setConfigDraft(null);
      setKeys(
        res.apiKeys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, status: k.status })),
      );
      const rs = await fetchWorkflowRuns(id).catch(() => []);
      setRuns(rs.map((r) => ({ id: r.id, status: r.status })));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const runAction = (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setActionError(null);
    void task()
      .catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  const selectedConfigText =
    configDraft && selected && configDraft.nodeId === selected.id
      ? configDraft.text
      : JSON.stringify(
          (selected?.data as { config?: Record<string, unknown> } | undefined)?.config ?? {},
          null,
          2,
        );

  const snapshot: WorkflowSnapshot = useMemo(
    () => snapshotGraph(draftName, nodes, edges),
    [draftName, nodes, edges],
  );

  const run = () => {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(runInput) as Record<string, unknown>;
    } catch {
      setRunLog(["输入不是合法 JSON"]);
      setActionError("运行输入不是合法 JSON");
      return;
    }
    const blockers = issues.filter((i) =>
      ["empty", "start-count", "end-count", "cycle"].includes(i.code),
    );
    if (blockers.length > 0) {
      setRunLog(blockers.map((b) => b.message));
      return;
    }
    setRunning(true);
    setRunLog([]);
    setRunOutputs("");
    streamWorkflow(toRunRequest(snapshot, input, detail?.app.id), {
      onNodeStart: (id, label) => setRunLog((p) => [...p, `▶ ${label ?? id}`]),
      onNodeResult: (id, status, meta) =>
        setRunLog((p) => [
          ...p,
          `${status === "success" ? "✓" : "✗"} ${id} ${meta.error ?? ""}`.trim(),
        ]),
      onDone: (outputs) => {
        setRunning(false);
        setRunOutputs(JSON.stringify(outputs).slice(0, 2000));
      },
      onError: (e) => {
        setRunning(false);
        setRunLog((p) => [...p, `失败：${e}`]);
      },
    });
  };

  return (
    <WorkspaceScreen title="工作流" description="用节点和连线组织可发布、可回放的 Agent 流程。">
      <ErrorText message={actionError} />
        <Card>
          <Sub>新建</Sub>
          <Field label="名称" value={name} onChange={setName} placeholder="我的工作流" />
          <Btn
            title={busy === "create" ? "创建中…" : "创建工作流"}
            disabled={busy !== null}
            onPress={() => {
              runAction("create", async () => {
                const d = await createWorkflow({ name: name.trim() || "未命名工作流" });
                setName("");
                list.reload();
                await open(d.app.id);
              });
            }}
          />
          <Sub>已有工作流</Sub>
          {list.loading ? <Loading /> : null}
          <ErrorText message={list.error} onRetry={list.reload} />
          {(list.data ?? []).map((w) => (
            <View
              key={w.id}
              style={{
                paddingVertical: 8,
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.outlineVariant,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Icon source="sitemap-outline" size={19} color={theme.colors.primary} />
                <Text variant="titleSmall" style={{ flex: 1 }} numberOfLines={1}>
                  {w.name}
                </Text>
                <Chip compact>{w.status}</Chip>
              </View>
              <Text
                variant="bodySmall"
                style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
              >
                {`草稿 rev ${w.draftRevision}`}
              </Text>
              <View style={{ flexDirection: "row", gap: 6, marginTop: 4 }}>
                <Btn
                  title={busy === `open-${w.id}` ? "打开中…" : "打开"}
                  kind="ghost"
                  disabled={busy !== null}
                  onPress={() => {
                    void open(w.id);
                  }}
                />
                <Btn
                  title="复制"
                  kind="ghost"
                  disabled={busy !== null}
                  onPress={() => {
                    runAction(`duplicate-${w.id}`, async () => {
                      await duplicateWorkflow(w.id);
                      list.reload();
                    });
                  }}
                />
                <Btn
                  title="删除"
                  kind="danger"
                  disabled={busy !== null}
                  onPress={() => {
                    runAction(`delete-${w.id}`, async () => {
                      await deleteWorkflow(w.id);
                      if (detail?.app.id === w.id) setDetail(null);
                      list.reload();
                    });
                  }}
                />
              </View>
            </View>
          ))}
        </Card>
        {detail ? (
          <Card>
            <Sub>{`草稿 ${detail.app.name} · rev${detail.app.draftRevision} · 版本 ${detail.versions.length}`}</Sub>
            <Field label="工作流名称" value={draftName} onChange={setDraftName} />
            <Sub>{`校验 ${issues.length} 项${
              issues.length
                ? "：" +
                  issues
                    .slice(0, 3)
                    .map((i) => i.message)
                    .join("；")
                : "（通过）"
            }`}</Sub>
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginVertical: 6 }}>
              <Btn
                title={busy === "save" ? "保存中…" : "保存草稿"}
                disabled={busy !== null}
                onPress={() => {
                  runAction("save", async () => {
                    setDetail(await saveWorkflowDraft(detail.app.id, detail.app.draftRevision, snapshot));
                  });
                }}
              />
              <Btn
                title={busy === "publish" ? "发布中…" : "发布"}
                kind="ghost"
                disabled={busy !== null || issues.length > 0}
                onPress={() => {
                  runAction("publish", async () => {
                    const d = await publishWorkflow(
                      detail.app.id,
                      detail.app.draftRevision,
                      "mobile publish",
                    );
                    setDetail(d);
                    list.reload();
                  });
                }}
              />
              {detail.versions[0] ? (
                <Btn
                  title="回滚到最新版本"
                  kind="ghost"
                  disabled={busy !== null}
                  onPress={() => {
                    runAction("rollback", async () => {
                      const latestVersion = detail.versions[0];
                      if (!latestVersion) return;
                      setDetail(await rollbackWorkflow(detail.app.id, latestVersion.id));
                    });
                  }}
                />
              ) : null}
            </View>
            <Divider style={{ marginVertical: 14 }} />
            <Text variant="titleMedium" style={{ marginBottom: 8 }}>
              添加节点
            </Text>
            <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
              {palette.map((p) => (
                <Btn
                  key={p.kind}
                  title={`+${p.label}`}
                  kind="ghost"
                  onPress={() => {
                    const n = createNode(newId(), p.kind as NodeKind);
                    setNodes((prev) => [...prev, n]);
                    setSelectedNode(n.id);
                  }}
                />
              ))}
            </View>
            <Divider style={{ marginVertical: 14 }} />
            <Text variant="titleMedium" style={{ marginBottom: 8 }}>
              节点画布 · {nodes.length}
            </Text>
            {nodes.map((n) => {
              const kind = String((n.data as { kind?: string }).kind ?? "?");
              const label = String((n.data as { label?: string }).label ?? n.id);
              return (
                <Surface
                  key={n.id}
                  elevation={0}
                  style={{
                    padding: 12,
                    borderWidth: 1,
                    borderColor:
                      n.id === selectedNode ? theme.colors.primary : theme.colors.outlineVariant,
                    borderRadius: 14,
                    marginBottom: 8,
                    backgroundColor:
                      n.id === selectedNode
                        ? theme.colors.primaryContainer
                        : theme.colors.surface,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Icon
                      source={kind === "condition" ? "source-branch" : "shape-outline"}
                      size={18}
                      color={theme.colors.primary}
                    />
                    <Text
                      variant="titleSmall"
                      style={{ flex: 1 }}
                      onPress={() => setSelectedNode(n.id)}
                    >
                      {label}
                    </Text>
                    <Chip compact>{kind}</Chip>
                  </View>
                  <View style={{ flexDirection: "row", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                    <Btn
                      title="上游连线"
                      kind="ghost"
                      onPress={() => {
                        const others = nodes.filter((x) => x.id !== n.id);
                        if (others.length === 0) return;
                        const src = others[others.length - 1]!;
                        setEdges((prev) => [...prev, createEdge(src.id, n.id)]);
                      }}
                    />
                    <Btn
                      title="单节点测试"
                      kind="ghost"
                      disabled={busy !== null}
                      onPress={() => {
                        let input: Record<string, unknown> = {};
                        try {
                          input = JSON.parse(runInput) as Record<string, unknown>;
                        } catch {
                          setRunLog(["测试输入不是合法 JSON"]);
                          setActionError("单节点测试输入不是合法 JSON");
                          return;
                        }
                        runAction(`test-${n.id}`, async () => {
                          const r = await testWorkflowNode(
                            {
                              id: n.id,
                              kind,
                              label,
                              config:
                                (n.data as { config?: Record<string, unknown> }).config ?? {},
                            },
                            input,
                          );
                          setRunLog((p) => [
                            ...p,
                            `单测 ${n.id}: ${r.status} ${JSON.stringify(r.outputs).slice(0, 300)}`,
                          ]);
                        });
                      }}
                    />
                    <Btn
                      title="删除"
                      kind="danger"
                      onPress={() => {
                        if (selectedNode === n.id) setSelectedNode("");
                        setNodes((prev) => prev.filter((x) => x.id !== n.id));
                        setEdges((prev) =>
                          prev.filter((e) => e.source !== n.id && e.target !== n.id),
                        );
                      }}
                    />
                  </View>
                </Surface>
              );
            })}
            <Divider style={{ marginVertical: 14 }} />
            <Text variant="titleMedium" style={{ marginBottom: 6 }}>
              连线 · {edges.length}
            </Text>
            {edges.map((e, i) => (
              <Text
                key={e.id ?? `${e.source}-${e.target}-${i}`}
              >{`${e.source} → ${e.target}${e.branchId ? ` [${e.branchId}]` : ""}`}</Text>
            ))}
            {edges.length > 0 ? (
              <Btn title="清空连线" kind="ghost" onPress={() => setEdges([])} />
            ) : null}
            {selected ? (
              <View style={{ marginTop: 16 }}>
                <Divider style={{ marginBottom: 14 }} />
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text variant="titleMedium" style={{ flex: 1 }}>
                    {`编辑 ${String((selected.data as { label?: string }).label ?? selected.id)}`}
                  </Text>
                  <IconButton
                    icon="close"
                    accessibilityLabel="收起节点配置"
                    onPress={() => {
                      setSelectedNode("");
                      setConfigDraft(null);
                    }}
                  />
                </View>
                <Field
                  label="label"
                  value={String((selected.data as { label?: string }).label ?? "")}
                  onChange={(v) =>
                    setNodes((prev) =>
                      prev.map((n) =>
                        n.id === selected.id
                          ? {
                              ...n,
                              data: { ...(n.data as object), label: v } as WorkflowNode["data"],
                            }
                          : n,
                      ),
                    )
                  }
                />
                <Field
                  label="config JSON"
                  value={selectedConfigText}
                  onChange={(v) => {
                    setConfigDraft({ nodeId: selected.id, text: v });
                    try {
                      const parsed = JSON.parse(v) as Record<string, unknown>;
                      setNodes((prev) =>
                        prev.map((n) =>
                          n.id === selected.id
                            ? {
                                ...n,
                                data: {
                                  ...(n.data as object),
                                  config: migrateNodeData(
                                    {
                                      kind: String(
                                        (selected.data as { kind?: string }).kind ?? "llm",
                                      ) as NodeKind,
                                      config: parsed,
                                    },
                                    selected.id,
                                  ).config,
                                } as WorkflowNode["data"],
                              }
                            : n,
                        ),
                      );
                    } catch {
                      // Keep the draft editable; a valid parse applies immediately.
                    }
                  }}
                  multiline
                  hint="修改会即时校验；格式错误时保留文本，但不会应用。"
                />
                <Surface
                  elevation={0}
                  style={{
                    padding: 12,
                    borderRadius: 12,
                    backgroundColor: theme.colors.surfaceVariant,
                    marginBottom: 8,
                  }}
                >
                  <Text variant="bodySmall" style={{ lineHeight: 19 }}>{`可用输入：${inputOptions(
                  {
                    id: selected.id,
                    data: {
                      kind: String((selected.data as { kind?: string }).kind ?? ""),
                      label: "",
                      config: ((selected.data as { config?: Record<string, unknown> }).config ??
                        {}) as Record<string, unknown>,
                    },
                  },
                  nodes.map((n) => ({
                    id: n.id,
                    data: {
                      kind: String((n.data as { kind?: string }).kind ?? ""),
                      config: ((n.data as { config?: Record<string, unknown> }).config ??
                        {}) as Record<string, unknown>,
                    },
                  })),
                  edges.map((e) => ({ source: e.source, target: e.target })),
                )
                  .slice(0, 5)
                  .map((o) => o.label)
                  .join(" / ")}`}</Text>
                  <Text variant="bodySmall" style={{ lineHeight: 19, marginTop: 6 }}>{`可用输出：${outputOptions({
                  id: selected.id,
                  data: {
                    kind: String((selected.data as { kind?: string }).kind ?? ""),
                    config: ((selected.data as { config?: Record<string, unknown> }).config ??
                      {}) as Record<string, unknown>,
                  },
                })
                  .slice(0, 5)
                  .map((o) => o.value)
                  .join(" / ")}`}</Text>
                  <Text
                    variant="labelSmall"
                    style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}
                  >
                    {`kind=${String((selected.data as { kind?: string }).kind ?? "")} · 支持 ${NODE_KINDS.length} 种节点`}
                  </Text>
                </Surface>
              </View>
            ) : null}
            <Field label="运行输入 JSON" value={runInput} onChange={setRunInput} multiline />
            {running ? (
              <Loading label="运行中…" />
            ) : (
              <Btn
                title="运行工作流"
                disabled={busy !== null}
                onPress={run}
              />
            )}
            {runLog.map((l, i) => (
              <Text key={i} style={{ marginTop: 2 }}>
                {l}
              </Text>
            ))}
            {runOutputs ? <Text style={{ marginTop: 6 }}>{`输出：${runOutputs}`}</Text> : null}
            <Sub>运行历史</Sub>
            {runs.map((r) => (
              <View
                key={r.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingVertical: 5,
                  borderBottomWidth: 1,
                  borderBottomColor: theme.colors.outlineVariant,
                }}
              >
                <Text>{`${r.id.slice(0, 8)} · ${r.status}`}</Text>
                <Btn
                  title="事件回放"
                  kind="ghost"
                  disabled={busy !== null}
                  onPress={() => {
                    runAction(`replay-${r.id}`, async () => {
                      const h = await fetchWorkflowRunEvents(detail.app.id, r.id);
                      setRunLog((p) => [...p, `回放 ${r.id.slice(0, 8)}: ${h.events.length} 事件`]);
                    });
                  }}
                />
              </View>
            ))}
            <Sub>API Key</Sub>
            {keys.map((k) => (
              <View
                key={k.id}
                style={{ flexDirection: "row", gap: 6, alignItems: "center", paddingVertical: 4 }}
              >
                <Text>{`${k.name} ${k.prefix} ${k.status}`}</Text>
                <Btn
                  title="吊销"
                  kind="danger"
                  disabled={busy !== null}
                  onPress={() => {
                    runAction(`revoke-${k.id}`, async () => {
                      await revokeWorkflowKey(detail.app.id, k.id);
                      await fetchWorkflow(detail.app.id).then((res) => {
                        setDetail(res.workflow);
                        setKeys(
                          res.apiKeys.map((x) => ({
                            id: x.id,
                            name: x.name,
                            prefix: x.prefix,
                            status: x.status,
                          })),
                        );
                      });
                    });
                  }}
                />
              </View>
            ))}
            <Btn
              title="新建 Key"
              kind="ghost"
              disabled={busy !== null}
              onPress={() => {
                runAction("key", async () => {
                  const r = await createWorkflowKey(detail.app.id, {
                    name: `mobile-${Date.now() % 10000}`,
                    rateLimitPerMinute: 60,
                  });
                  setRunOutputs(`新 Key（仅显示一次）：${r.rawKey}`);
                  const res = await fetchWorkflow(detail.app.id);
                  setDetail(res.workflow);
                  setKeys(
                    res.apiKeys.map((x) => ({
                      id: x.id,
                      name: x.name,
                      prefix: x.prefix,
                      status: x.status,
                    })),
                  );
                });
              }}
            />
          </Card>
        ) : null}
    </WorkspaceScreen>
  );
}
