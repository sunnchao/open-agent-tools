import React, { useState } from "react";
import { View } from "react-native";
import { Icon, Surface, Text, useTheme } from "react-native-paper";
import {
  listEntities,
  neighborsOf,
  reconcileGraph,
  relationTypes,
  retrieveGraph,
  syncStatus,
} from "../api/graph";
import { useAsync } from "../hooks/useAsync";
import {
  Btn,
  Card,
  ErrorText,
  Field,
  Loading,
  Sub,
} from "../components/ui";
import { WorkspaceScreen } from "../components/workspaceScreen";

export function GraphScreen() {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [out, setOut] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const entities = useAsync(() => listEntities({ limit: 20 }));
  const relTypes = useAsync(relationTypes);
  const sync = useAsync(syncStatus);

  const run = (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setActionError(null);
    void task()
      .catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  return (
    <WorkspaceScreen title="知识图谱" description="沿实体与关系检索上下文，并检查图谱与源数据是否一致。">
      <ErrorText message={actionError} />
        <Card>
          <Field label="检索" value={query} onChange={setQuery} placeholder="输入实体/关系关键词" />
          <Btn
            title={busy === "retrieve" ? "检索中…" : "子图检索"}
            disabled={busy !== null || !query.trim()}
            onPress={() => {
              run("retrieve", async () => {
                const r = await retrieveGraph(query, 2);
                setOut(`${r.formatted}`.slice(0, 800) || `(种子 ${r.seeds.length})`);
              });
            }}
          />
          {out ? (
            <Surface
              elevation={0}
              style={{
                marginTop: 14,
                padding: 14,
                borderRadius: 14,
                backgroundColor: theme.colors.surfaceVariant,
              }}
            >
              <Text variant="bodySmall" style={{ lineHeight: 20 }}>
                {out}
              </Text>
            </Surface>
          ) : null}
        </Card>
        <Card>
          <Sub>实体（前20）</Sub>
          {entities.loading ? <Loading /> : null}
          <ErrorText message={entities.error} onRetry={entities.reload} />
          {(entities.data?.entities ?? []).slice(0, 20).map((e) => (
            <View
              key={e.id}
              style={{
                paddingVertical: 8,
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.outlineVariant,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Icon source="circle-medium" size={17} color={theme.colors.secondary} />
                <Text variant="titleSmall" style={{ flex: 1 }} numberOfLines={1}>
                  {e.name}
                </Text>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {e.type}
                </Text>
              </View>
              <Btn
                title="展开邻居"
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  run(`neighbors-${e.id}`, async () => {
                    const g = await neighborsOf(e.id, 2);
                    setOut(`邻居 节点${g.nodes.length} 边${g.edges.length}`);
                  });
                }}
              />
            </View>
          ))}
        </Card>
        <Card>
          <Sub>关系类型</Sub>
          {relTypes.loading ? <Loading /> : null}
          <ErrorText message={relTypes.error} onRetry={relTypes.reload} />
          {(relTypes.data?.types ?? []).slice(0, 10).map((t) => (
            <View
              key={t.relType}
              style={{ flexDirection: "row", alignItems: "center", paddingVertical: 6 }}
            >
              <Text variant="bodyMedium" style={{ flex: 1 }}>
                {t.relType}
              </Text>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                {t.count}
              </Text>
            </View>
          ))}
        </Card>
        <Card>
          <Sub>同步状态</Sub>
          {sync.loading ? <Loading /> : null}
          <ErrorText message={sync.error} onRetry={sync.reload} />
          {sync.data ? (
            <Text>
              {sync.data.inSync
                ? "已同步"
                : `缺失 ${sync.data.missing.length} · 过期 ${sync.data.stale.length} · 孤儿 ${sync.data.orphan.length}`}
            </Text>
          ) : null}
          <Btn
            title={busy === "reconcile" ? "对账中…" : "一键对账"}
            disabled={busy !== null}
            onPress={() => {
              run("reconcile", async () => {
                await reconcileGraph();
                sync.reload();
              });
            }}
          />
        </Card>
    </WorkspaceScreen>
  );
}
