import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { Chip, Divider, Icon, Surface, Text, useTheme } from "react-native-paper";
import { AGENT_KEY, GATEWAY_KEY, MCP_KEY, TOKEN_KEY, WORKSPACE_KEY } from "../lib/config";
import { getSettings, setAuthMemory } from "../lib/http";
import { storageSet } from "../lib/storage";
import {
  clearMcpGatewayConfig,
  createPublishedApp,
  createWorkspace,
  deletePublishedApp,
  fetchBranding,
  fetchIdentityStatus,
  fetchImChannels,
  fetchImStatus,
  fetchMcpGatewayConfig,
  fetchProviders,
  fetchPublishedAppIdentity,
  fetchPublishedApps,
  fetchUsage,
  fetchWorkspaces,
  probeProviderModels,
  removeImChannel,
  removeProvider,
  resetBranding,
  restartImChannel,
  rotateAccessToken,
  saveBranding,
  saveImChannel,
  saveMcpGatewayConfig,
  saveProvider,
  setDefaultProvider,
  updatePublishedApp,
  fetchAdminSchemaSources,
  IDENTITY_PROVIDER_LABELS,
  LDAP_READINESS_LABELS,
  type ImPlatform,
  type SchemaSourceMetadata,
} from "../api/misc";
import {
  duplicateSchemaSource,
  fetchSchemaCatalog,
  removeSchemaSource,
  saveSchemaSource,
  setDefaultSchemaSource,
  syncSchemaSource,
  testSchemaSource,
} from "../api/observatory";
import { OptionBar } from "../components/ui";
import { downloadExport, usageExportPath, type ExportFormat } from "../api/exports";
import { shareExport } from "../lib/files";
import { useAsync } from "../hooks/useAsync";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { Btn, Card, ErrorText, Field, Loading, Sub } from "../components/ui";
import { WorkspaceScreen } from "../components/workspaceScreen";

export function SettingsScreen() {
  const theme = useTheme();
  const [token, setToken] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [agentUrl, setAgentUrl] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [saved, setSaved] = useState("");
  const providers = useAsync(() => fetchProviders({ includeDisabled: true }));
  const workspaces = useAsync(fetchWorkspaces);
  const usage = useAsync(() => fetchUsage({ days: 30 }));
  const gateway = useAsync(fetchMcpGatewayConfig);
  const imChannels = useAsync(fetchImChannels);
  const imStatus = useAsync(fetchImStatus);
  const apps = useAsync(fetchPublishedApps);
  const branding = useAsync(fetchBranding);
  const schemaSources = useAsync<SchemaSourceMetadata[]>(fetchAdminSchemaSources);
  const identity = useAsync(fetchIdentityStatus);
  const appIdentity = useAsync(fetchPublishedAppIdentity);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaBusy, setSchemaBusy] = useState<string | null>(null);
  const [schemaName, setSchemaName] = useState("");
  const [schemaConn, setSchemaConn] = useState("");
  const [schemaConnector, setSchemaConnector] = useState<"mysql" | "postgresql">("mysql");
  const [schemaDb, setSchemaDb] = useState("");
  const [catalogPreview, setCatalogPreview] = useState("");
  const [usageExporting, setUsageExporting] = useState<ExportFormat | null>(null);
  const [usageExportMsg, setUsageExportMsg] = useState("");

  const exportUsage = (format: ExportFormat) => {
    if (usageExporting) return;
    setUsageExporting(format);
    setUsageExportMsg("");
    void (async () => {
      try {
        const dl = await downloadExport(
          usageExportPath({ days: 30 }, format),
          `usage-events.${format}`,
        );
        const uri = await shareExport(dl);
        setUsageExportMsg(`已导出 ${dl.filename}（${uri.slice(0, 60)}…）`);
      } catch (e) {
        setUsageExportMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setUsageExporting(null);
      }
    })();
  };
  const [gwUrl, setGwUrl] = useState("");
  const [gwKey, setGwKey] = useState("");
  const [wsName, setWsName] = useState("");
  const [imName, setImName] = useState("");
  const [imAppId, setImAppId] = useState("");
  const [imPlatform, setImPlatform] = useState<ImPlatform>("feishu");
  const [brandName, setBrandName] = useState("");
  const { busy, error: actionError, setError: setActionError, run } = useAsyncAction();

  useEffect(() => {
    void getSettings()
      .then((s) => {
        setToken(s.token);
        setWorkspaceId(s.workspaceId);
        setAgentUrl(s.agentUrl);
        setMcpUrl(s.mcpUrl);
        setGatewayUrl(s.gatewayUrl);
      })
      .catch((e: unknown) => setActionError(`读取本地连接配置失败：${String(e)}`));
  }, []);

  const saveConn = async () => {
    setAuthMemory({
      token: token.trim(),
      workspaceId: workspaceId.trim(),
      agentUrl: agentUrl.trim() || undefined,
      mcpUrl: mcpUrl.trim() || undefined,
      gatewayUrl: gatewayUrl.trim() || undefined,
    });
    await storageSet(TOKEN_KEY, token.trim()).catch(() => undefined);
    await storageSet(WORKSPACE_KEY, workspaceId.trim()).catch(() => undefined);
    await storageSet(AGENT_KEY, agentUrl.trim()).catch(() => undefined);
    await storageSet(MCP_KEY, mcpUrl.trim()).catch(() => undefined);
    await storageSet(GATEWAY_KEY, gatewayUrl.trim()).catch(() => undefined);
    setSaved(`已保存 ${new Date().toLocaleTimeString()}`);
  };

  return (
    <WorkspaceScreen title="设置" description="管理服务连接、模型通道、数据源与组织级配置。">
      <ErrorText message={actionError} />
      <Card>
        <Sub>连接（与 Web 同鉴权头）</Sub>
        <Field
          label="Agent Server"
          value={agentUrl}
          onChange={setAgentUrl}
          placeholder="http://localhost:3000"
        />
        <Field
          label="MCP Control Plane"
          value={mcpUrl}
          onChange={setMcpUrl}
          placeholder="http://localhost:4200"
        />
        <Field
          label="MCP Gateway"
          value={gatewayUrl}
          onChange={setGatewayUrl}
          placeholder="http://localhost:4100"
        />
        <Field
          label="Studio Token"
          value={token}
          onChange={setToken}
          secret
          placeholder="未配置则保持本地体验"
        />
        <Field
          label="Workspace ID（留空走默认空间）"
          value={workspaceId}
          onChange={setWorkspaceId}
          placeholder=""
        />
        <Btn
          title={busy === "connection" ? "保存中…" : "保存连接"}
          disabled={busy !== null}
          onPress={() => {
            run("connection", saveConn);
          }}
        />
        {saved ? (
          <Text variant="bodySmall" style={{ marginTop: 6, color: theme.colors.primary }}>
            {saved}
          </Text>
        ) : null}
      </Card>
      <Card>
        <Sub>Provider</Sub>
        {providers.loading ? <Loading /> : null}
        <ErrorText message={providers.error} onRetry={providers.reload} />
        {(providers.data ?? []).map((p) => (
          <View
            key={p.id}
            style={{
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.outlineVariant,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Icon source="robot-outline" size={19} color={theme.colors.primary} />
              <Text variant="titleSmall" style={{ flex: 1 }} numberOfLines={1}>
                {p.name}
              </Text>
              {p.isDefault ? <Chip compact>默认</Chip> : null}
              {!p.enabled ? <Chip compact>停用</Chip> : null}
            </View>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
            >
              {p.format}
            </Text>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 4 }}>
              <Btn
                title="设默认"
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  run(`provider-default-${p.id}`, async () => {
                    await setDefaultProvider(p.id);
                    providers.reload();
                  });
                }}
              />
              <Btn
                title="拉模型"
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  run(`provider-models-${p.id}`, async () => {
                    await probeProviderModels({ baseUrl: p.baseUrl });
                    providers.reload();
                  });
                }}
              />
              <Btn
                title="删除"
                kind="danger"
                disabled={busy !== null}
                onPress={() => {
                  run(`provider-delete-${p.id}`, async () => {
                    await removeProvider(p.id);
                    providers.reload();
                  });
                }}
              />
            </View>
          </View>
        ))}
        <Btn
          title="新增示例 Provider"
          kind="ghost"
          disabled={busy !== null}
          onPress={() => {
            run("provider-create", async () => {
              await saveProvider({
                name: `provider-${Date.now() % 10000}`,
                baseUrl: "https://api.openai.com/v1",
                models: ["gpt-4o-mini"],
                enabled: true,
                format: "openai-chat",
              });
              providers.reload();
            });
          }}
        />
      </Card>
      <Card>
        <Sub>Schema 数据源（{schemaSources.data?.length ?? 0}）</Sub>
        {schemaSources.loading ? <Loading /> : null}
        <ErrorText message={schemaSources.error} onRetry={schemaSources.reload} />
        <ErrorText message={schemaError} />
        <Field label="名称" value={schemaName} onChange={setSchemaName} placeholder="main-db" />
        <OptionBar
          options={["mysql", "postgresql"] as const}
          value={schemaConnector}
          onChange={setSchemaConnector}
          labels={{ mysql: "MySQL", postgresql: "PostgreSQL" }}
        />
        <Field
          label="连接串（新增必填，编辑留空不改）"
          value={schemaConn}
          onChange={setSchemaConn}
          placeholder="mysql://readonly:pass@host:3306/db"
          secret
        />
        <Field label="databaseName" value={schemaDb} onChange={setSchemaDb} placeholder="app_db" />
        <Btn
          title={schemaBusy === "create" ? "保存中…" : "新增数据源"}
          kind="ghost"
          disabled={schemaBusy !== null || busy !== null}
          onPress={() => {
            if (!schemaName.trim()) {
              setSchemaError("请填写名称");
              return;
            }
            setSchemaBusy("create");
            setSchemaError(null);
            void saveSchemaSource({
              name: schemaName.trim(),
              connector: schemaConnector,
              ...(schemaConn.trim() ? { connectionString: schemaConn.trim() } : {}),
              databaseName: schemaDb.trim(),
              schemaName: "",
              tableFilter: [],
              semanticProfile: "generic",
              enabled: true,
            })
              .then(() => {
                setSchemaName("");
                setSchemaConn("");
                setSchemaDb("");
                schemaSources.reload();
              })
              .catch((e: unknown) => setSchemaError(e instanceof Error ? e.message : String(e)))
              .finally(() => setSchemaBusy(null));
          }}
        />
        {(schemaSources.data ?? []).map((item: SchemaSourceMetadata) => (
          <View
            key={item.id}
            style={{
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.outlineVariant,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Icon source="database-outline" size={19} color={theme.colors.primary} />
              <Text variant="titleSmall" style={{ flex: 1 }} numberOfLines={1}>
                {item.name}
              </Text>
              {item.isDefault ? <Chip compact>默认</Chip> : null}
            </View>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
            >
              {item.syncStatus}
            </Text>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
              <Btn
                title="设默认"
                kind="ghost"
                disabled={schemaBusy !== null || busy !== null}
                onPress={() => {
                  setSchemaBusy(item.id);
                  run(`schema-default-${item.id}`, async () => {
                    try {
                      await setDefaultSchemaSource(item.id);
                      schemaSources.reload();
                    } catch (e) {
                      setSchemaError(e instanceof Error ? e.message : String(e));
                      throw e;
                    } finally {
                      setSchemaBusy(null);
                    }
                  });
                }}
              />
              <Btn
                title="同步"
                kind="ghost"
                disabled={schemaBusy !== null || busy !== null}
                onPress={() => {
                  setSchemaBusy(item.id);
                  run(`schema-sync-${item.id}`, async () => {
                    try {
                      await syncSchemaSource(item.id);
                      schemaSources.reload();
                    } catch (e) {
                      setSchemaError(e instanceof Error ? e.message : String(e));
                      throw e;
                    } finally {
                      setSchemaBusy(null);
                    }
                  });
                }}
              />
              <Btn
                title="测试"
                kind="ghost"
                disabled={schemaBusy !== null || busy !== null}
                onPress={() => {
                  setSchemaBusy(item.id);
                  run(`schema-test-${item.id}`, async () => {
                    try {
                      const r = await testSchemaSource({ id: item.id });
                      setCatalogPreview(`连接成功 ${r.database} ${r.version}`);
                    } catch (e) {
                      setSchemaError(e instanceof Error ? e.message : String(e));
                      throw e;
                    } finally {
                      setSchemaBusy(null);
                    }
                  });
                }}
              />
              <Btn
                title="目录"
                kind="ghost"
                disabled={schemaBusy !== null || busy !== null}
                onPress={() => {
                  setSchemaBusy(item.id);
                  run(`schema-catalog-${item.id}`, async () => {
                    try {
                      const c = await fetchSchemaCatalog(item.id);
                      setCatalogPreview(
                        `${c.database} · 表 ${c.tables.length} · 关系 ${c.relationCount}`,
                      );
                    } catch (e) {
                      setSchemaError(e instanceof Error ? e.message : String(e));
                      throw e;
                    } finally {
                      setSchemaBusy(null);
                    }
                  });
                }}
              />
              <Btn
                title="复制"
                kind="ghost"
                disabled={schemaBusy !== null || busy !== null}
                onPress={() => {
                  setSchemaBusy(item.id);
                  run(`schema-copy-${item.id}`, async () => {
                    try {
                      await duplicateSchemaSource(item.id);
                      schemaSources.reload();
                    } catch (e) {
                      setSchemaError(e instanceof Error ? e.message : String(e));
                      throw e;
                    } finally {
                      setSchemaBusy(null);
                    }
                  });
                }}
              />
              <Btn
                title="删除"
                kind="danger"
                disabled={schemaBusy !== null || busy !== null}
                onPress={() => {
                  setSchemaBusy(item.id);
                  run(`schema-delete-${item.id}`, async () => {
                    try {
                      await removeSchemaSource(item.id);
                      schemaSources.reload();
                    } catch (e) {
                      setSchemaError(e instanceof Error ? e.message : String(e));
                      throw e;
                    } finally {
                      setSchemaBusy(null);
                    }
                  });
                }}
              />
            </View>
          </View>
        ))}
        {catalogPreview ? (
          <Surface
            elevation={0}
            style={{
              marginTop: 10,
              padding: 12,
              borderRadius: 12,
              backgroundColor: theme.colors.surfaceVariant,
            }}
          >
            <Text variant="bodySmall">{catalogPreview}</Text>
          </Surface>
        ) : null}
      </Card>
      <Card>
        <Sub>企业身份</Sub>
        {identity.loading ? <Loading /> : null}
        <ErrorText message={identity.error} onRetry={identity.reload} />
        {identity.data ? (
          <View>
            <Text>{`Studio 身份：${IDENTITY_PROVIDER_LABELS[identity.data.provider]}（${identity.data.mode}）`}</Text>
            <Text>{`Issuer / Audience：${identity.data.issuer ?? "未配置"} / ${identity.data.audience ?? "未配置"}`}</Text>
            <Text>{`组 / 角色 Claim：${identity.data.groupsClaim} / ${identity.data.rolesClaim}`}</Text>
            <Text>{`LDAP 网关：${LDAP_READINESS_LABELS[identity.data.ldap.readiness]}${identity.data.ldap.summary ? ` · ${identity.data.ldap.summary}` : ""}`}</Text>
            {identity.data.configError ? (
              <Text>{`配置异常：${identity.data.configError}`}</Text>
            ) : null}
          </View>
        ) : null}
      </Card>
      <Card>
        <Sub>MCP Gateway 配置</Sub>
        {gateway.loading ? <Loading /> : null}
        <ErrorText message={gateway.error} onRetry={gateway.reload} />
        {gateway.data ? (
          <Text>{`来源 ${gateway.data.source} · ${gateway.data.configured ? gateway.data.gatewayUrl : "未配置"}`}</Text>
        ) : null}
        <Field
          label="gatewayUrl"
          value={gwUrl}
          onChange={setGwUrl}
          placeholder="http://gateway:4100"
        />
        <Field label="apiKey（留空不改）" value={gwKey} onChange={setGwKey} secret />
        <Btn
          title="保存"
          disabled={busy !== null}
          onPress={() => {
            run("gateway-save", async () => {
              await saveMcpGatewayConfig({
                gatewayUrl: gwUrl.trim() || gateway.data?.gatewayUrl || "",
                ...(gwKey.trim() ? { apiKey: gwKey.trim() } : {}),
              });
              setGwUrl("");
              setGwKey("");
              gateway.reload();
            });
          }}
        />
        <Btn
          title="清除"
          kind="danger"
          disabled={busy !== null}
          onPress={() => {
            run("gateway-clear", async () => {
              await clearMcpGatewayConfig();
              gateway.reload();
            });
          }}
        />
      </Card>
      <Card>
        <Sub>IM 渠道</Sub>
        {imChannels.loading ? <Loading /> : null}
        <ErrorText message={imChannels.error} onRetry={imChannels.reload} />
        {imStatus.data ? (
          <Text>{`总览 ${imStatus.data.connected ? "已连接" : "未连接"}`}</Text>
        ) : null}
        <Field label="名称" value={imName} onChange={setImName} placeholder="群机器人" />
        <Field label="appId" value={imAppId} onChange={setImAppId} placeholder="cli_xxx" />
        <View style={{ flexDirection: "row", gap: 6, marginBottom: 8 }}>
          <Btn
            title="飞书"
            kind={imPlatform === "feishu" ? "primary" : "ghost"}
            onPress={() => setImPlatform("feishu")}
          />
          <Btn
            title="钉钉"
            kind={imPlatform === "dingtalk" ? "primary" : "ghost"}
            onPress={() => setImPlatform("dingtalk")}
          />
        </View>
        <Btn
          title={busy === "im-create" ? "创建中…" : "新增渠道"}
          disabled={busy !== null || !imAppId.trim()}
          onPress={() => {
            run("im-create", async () => {
              await saveImChannel({
                name: imName.trim() || "IM",
                platform: imPlatform,
                appId: imAppId.trim(),
                ragSources: [],
                ragTopK: 5,
                requireMention: true,
                enabled: true,
              });
              setImName("");
              setImAppId("");
              imChannels.reload();
            });
          }}
        />
        {(imChannels.data ?? []).map((c) => (
          <View
            key={c.id}
            style={{
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.outlineVariant,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Icon source="message-processing-outline" size={19} color={theme.colors.primary} />
              <Text variant="titleSmall" style={{ flex: 1 }}>
                {c.name}
              </Text>
              <Chip compact>{c.connected ? "已连接" : "未连接"}</Chip>
            </View>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 4 }}>
              <Btn
                title="重启"
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  run(`im-restart-${c.id}`, async () => {
                    await restartImChannel(c.id);
                    imChannels.reload();
                    imStatus.reload();
                  });
                }}
              />
              <Btn
                title="删除"
                kind="danger"
                disabled={busy !== null}
                onPress={() => {
                  run(`im-delete-${c.id}`, async () => {
                    await removeImChannel(c.id);
                    imChannels.reload();
                  });
                }}
              />
            </View>
          </View>
        ))}
      </Card>
      <Card>
        <Sub>发布应用</Sub>
        {appIdentity.loading ? <Loading /> : null}
        <ErrorText message={appIdentity.error} onRetry={appIdentity.reload} />
        {appIdentity.data ? (
          <Text>{`员工入口身份：${appIdentity.data.enabled ? `已启用（${appIdentity.data.keyId ?? "未配 Key"} · ${appIdentity.data.identityMode}）` : "未启用"}`}</Text>
        ) : null}
        {apps.loading ? <Loading /> : null}
        <ErrorText message={apps.error} onRetry={apps.reload} />
        {(apps.data ?? []).map((a) => (
          <View key={a.id} style={{ paddingVertical: 4 }}>
            <Text numberOfLines={1}>{`${a.name} · ${a.slug} · ${a.status}`}</Text>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
              <Btn
                title={a.status === "ACTIVE" ? "归档" : "激活"}
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  run(`app-status-${a.id}`, async () => {
                    await updatePublishedApp(a.id, {
                      status: a.status === "ACTIVE" ? "ARCHIVED" : "ACTIVE",
                    });
                    apps.reload();
                  });
                }}
              />
              <Btn
                title="轮换口令"
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  run(`app-token-${a.id}`, async () => {
                    await rotateAccessToken(a.id, true);
                    apps.reload();
                  });
                }}
              />
              <Btn
                title="删除"
                kind="danger"
                disabled={busy !== null}
                onPress={() => {
                  run(`app-delete-${a.id}`, async () => {
                    await deletePublishedApp(a.id);
                    apps.reload();
                  });
                }}
              />
            </View>
          </View>
        ))}
        <Btn
          title="新建应用"
          kind="ghost"
          disabled={busy !== null}
          onPress={() => {
            run("app-create", async () => {
              await createPublishedApp({ name: `app-${Date.now() % 10000}` });
              apps.reload();
            });
          }}
        />
      </Card>
      <Card>
        <Sub>品牌</Sub>
        {branding.loading ? <Loading /> : null}
        <ErrorText message={branding.error} onRetry={branding.reload} />
        {branding.data ? (
          <Text>{`${branding.data.productName} · ${branding.data.markText}`}</Text>
        ) : null}
        <Field
          label="productName"
          value={brandName}
          onChange={setBrandName}
          placeholder="保持空则不改"
        />
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Btn
            title="保存"
            kind="ghost"
            disabled={busy !== null || !branding.data}
            onPress={() => {
              if (!branding.data) return;
              run("branding-save", async () => {
                await saveBranding({
                  ...branding.data!,
                  ...(brandName.trim() ? { productName: brandName.trim() } : {}),
                });
                setBrandName("");
                branding.reload();
              });
            }}
          />
          <Btn
            title="重置"
            kind="danger"
            disabled={busy !== null}
            onPress={() => {
              run("branding-reset", async () => {
                await resetBranding();
                branding.reload();
              });
            }}
          />
        </View>
      </Card>
      <Card>
        <Sub>工作区与用量</Sub>
        {workspaces.loading ? <Loading /> : null}
        <ErrorText message={workspaces.error} onRetry={workspaces.reload} />
        <Text>{`工作区 ${(workspaces.data ?? []).length} 个`}</Text>
        <Field label="新建工作区名称" value={wsName} onChange={setWsName} placeholder="team-a" />
        <Btn
          title="创建"
          kind="ghost"
          disabled={busy !== null || !wsName.trim()}
          onPress={() => {
            run("workspace-create", async () => {
              await createWorkspace({ name: wsName.trim() });
              setWsName("");
              workspaces.reload();
            });
          }}
        />
        {usage.data ? (
          <Text
            style={{ marginTop: 6 }}
          >{`30天 turns ${usage.data.totals.chatTurns} · tools ${usage.data.totals.toolCalls} · tokens ${usage.data.totals.totalTokens}`}</Text>
        ) : null}
        <Divider style={{ marginVertical: 12 }} />
        <View style={{ flexDirection: "row", gap: 6, marginTop: 6 }}>
          <Btn
            title={usageExporting === "csv" ? "导出中…" : "导出 CSV"}
            kind="ghost"
            disabled={usageExporting !== null}
            onPress={() => exportUsage("csv")}
          />
          <Btn
            title={usageExporting === "json" ? "导出中…" : "导出 JSON"}
            kind="ghost"
            disabled={usageExporting !== null}
            onPress={() => exportUsage("json")}
          />
        </View>
        {usageExportMsg ? (
          <Text variant="bodySmall" style={{ marginTop: 8, color: theme.colors.onSurfaceVariant }}>
            {usageExportMsg}
          </Text>
        ) : null}
      </Card>
    </WorkspaceScreen>
  );
}
