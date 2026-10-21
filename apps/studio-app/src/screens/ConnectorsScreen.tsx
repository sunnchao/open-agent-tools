import React, { useState } from "react";
import { View } from "react-native";
import { Icon, Surface, Text, useTheme } from "react-native-paper";
import {
  CONNECTOR_TYPE_LABELS,
  CONNECTOR_TYPES,
  fetchConnectorRuns,
  fetchConnectors,
  removeConnector,
  saveConnector,
  statusLabel,
  syncConnector,
  type ConnectorType,
} from "../api/misc";
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

export function ConnectorsScreen() {
  const theme = useTheme();
  const list = useAsync(fetchConnectors);
  const [name, setName] = useState("");
  const [type, setType] = useState<ConnectorType>("http");
  const [baseUrl, setBaseUrl] = useState("");
  const [runs, setRuns] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setActionError(null);
    void task()
      .catch((e: unknown) => setActionError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };

  return (
    <WorkspaceScreen title="连接器" description="把分散在外部系统的内容同步进知识库，并追踪每次运行。">
      <ErrorText message={actionError} />
        <Card>
          <Sub>新建连接器</Sub>
          <Field label="名称" value={name} onChange={setName} placeholder="docs-sync" />
          <Sub>
            {CONNECTOR_TYPES.map(
              (t) => `${t === type ? "●" : "○"} ${CONNECTOR_TYPE_LABELS[t]}`,
            ).join("  ")}
          </Sub>
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {CONNECTOR_TYPES.map((t) => (
              <Btn
                key={t}
                title={CONNECTOR_TYPE_LABELS[t]}
                kind={t === type ? "primary" : "ghost"}
                onPress={() => setType(t)}
              />
            ))}
          </View>
          <Field label="baseUrl" value={baseUrl} onChange={setBaseUrl} placeholder="https://…" />
          <Btn
            title={busy === "create" ? "保存中…" : "保存连接器"}
            disabled={busy !== null || !name.trim()}
            onPress={() => {
              run("create", async () => {
                await saveConnector({
                  name: name.trim(),
                  type,
                  baseUrl,
                  credentials: {},
                  filter: { include: [], exclude: [], maxDocuments: null },
                  enabled: true,
                });
                setName("");
                setBaseUrl("");
                list.reload();
              });
            }}
          />
        </Card>
        <Card>
          <Sub>连接器列表</Sub>
          {list.loading ? <Loading /> : null}
          <ErrorText message={list.error} onRetry={list.reload} />
          {(list.data ?? []).map((c) => (
            <View
              key={c.id}
              style={{
                paddingVertical: 11,
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.outlineVariant,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Icon source="transit-connection-variant" size={19} color={theme.colors.primary} />
                <Text variant="titleSmall" style={{ flex: 1 }} numberOfLines={1}>
                  {c.name}
                </Text>
                <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  {statusLabel(c.lastStatus)}
                </Text>
              </View>
              <Text
                variant="bodySmall"
                style={{ color: theme.colors.onSurfaceVariant, marginTop: 3 }}
              >
                {CONNECTOR_TYPE_LABELS[c.type]}
              </Text>
              <View style={{ flexDirection: "row", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                <Btn
                  title={busy === `sync-${c.id}` ? "同步中…" : "同步"}
                  kind="ghost"
                  disabled={busy !== null}
                  onPress={() => {
                    run(`sync-${c.id}`, async () => {
                      await syncConnector(c.id);
                      list.reload();
                    });
                  }}
                />
                <Btn
                  title="运行记录"
                  kind="ghost"
                  disabled={busy !== null}
                  onPress={() => {
                    run(`runs-${c.id}`, async () => {
                      const r = await fetchConnectorRuns(c.id);
                      setRuns(
                        r
                          .slice(0, 3)
                          .map((x) => `${x.status} 拉取${x.pulled} 入库${x.ingested}`)
                          .join("\n") || "(空)",
                      );
                    });
                  }}
                />
                <Btn
                  title="删除"
                  kind="danger"
                  disabled={busy !== null}
                  onPress={() => {
                    run(`delete-${c.id}`, async () => {
                      await removeConnector(c.id);
                      list.reload();
                    });
                  }}
                />
              </View>
            </View>
          ))}
          {runs ? (
            <Surface
              elevation={0}
              style={{
                marginTop: 12,
                padding: 12,
                borderRadius: 12,
                backgroundColor: theme.colors.surfaceVariant,
              }}
            >
              <Text variant="bodySmall" style={{ lineHeight: 20 }}>
                {runs}
              </Text>
            </Surface>
          ) : null}
        </Card>
    </WorkspaceScreen>
  );
}
