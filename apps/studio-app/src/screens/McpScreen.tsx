import React, { useState } from "react";
import { View } from "react-native";
import { Chip, Divider, Icon, Surface, Text, useTheme } from "react-native-paper";
import {
  addPrompt,
  addTool,
  buildVersion,
  callGatewayTool,
  createApiKey,
  createClient,
  createService,
  deleteGrant,
  deletePrompt,
  deleteService,
  deleteTool,
  disableService,
  enableService,
  forkDraftVersion,
  getAuditEvent,
  getServiceEnvironment,
  getToolSla,
  listApiKeys,
  listAuditEvents,
  listBuilds,
  listClientQuotas,
  listClientUsage,
  listClients,
  listGrants,
  listMarketplaceServices,
  listServices,
  listVersions,
  previewPrompt,
  uploadArtifact,
  publishVersion,
  revokeApiKey,
  rollbackVersion,
  updateService,
  updateServiceEnvironment,
  updateTool,
  updateVersionLimits,
  upsertClientQuota,
  upsertGrant,
  validateVersion,
  type ApiClientRecord,
  type McpService,
  type McpVersion,
} from "../api/mcp";
import { useAsync } from "../hooks/useAsync";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { pickDocuments, sha256DigestOf } from "../lib/files";
import { Btn, Card, ErrorText, Field, Loading, Sub } from "../components/ui";
import { WorkspaceScreen } from "../components/workspaceScreen";

export function McpScreen() {
  const theme = useTheme();
  const services = useAsync(listServices);
  const builds = useAsync(listBuilds);
  const audits = useAsync(() => listAuditEvents());
  const sla = useAsync(() => getToolSla({ window: "24h" }));
  const clients = useAsync(listClients);
  const [clientName, setClientName] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const [freshKey, setFreshKey] = useState("");
  const [openClient, setOpenClient] = useState<ApiClientRecord | null>(null);
  const [clientDetailLoading, setClientDetailLoading] = useState(false);
  const [clientKeys, setClientKeys] = useState<
    Array<{ id: string; prefix?: string; status: string; expiresAt: string | null }>
  >([]);
  const [clientGrants, setClientGrants] = useState<
    Array<{ id: string; serviceId: string; scopes: string[] }>
  >([]);
  const [clientQuotas, setClientQuotas] = useState<
    Array<{ id: string; serviceId: string | null; qpsLimit: number; dailyCallLimit: number }>
  >([]);
  const [clientUsage, setClientUsage] = useState<
    Array<{ id: string; toolName: string; status: string }>
  >([]);
  const [marketplace, setMarketplace] = useState<
    Array<{ id: string; name: string; toolCount: number | null }>
  >([]);
  const [grantService, setGrantService] = useState("");
  const [quotaQps, setQuotaQps] = useState("10");
  const [quotaDaily, setQuotaDaily] = useState("1000");

  const loadClientDetail = async (clientId: string) => {
    setClientDetailLoading(true);
    setClientError(null);
    try {
      const [keys, grants, quotas, usage, market] = await Promise.all([
        listApiKeys(clientId),
        listGrants(clientId),
        listClientQuotas(clientId),
        listClientUsage(clientId, { limit: 5 }).catch(() => ({
          events: [],
          summary: { total: 0, reserved: 0, succeeded: 0, failed: 0 },
        })),
        listMarketplaceServices().catch(() => []),
      ]);
      setClientKeys(keys);
      setClientGrants(grants);
      setClientQuotas(quotas);
      setClientUsage(usage.events);
      setMarketplace(market);
    } catch (e) {
      setClientError(e instanceof Error ? e.message : String(e));
    } finally {
      setClientDetailLoading(false);
    }
  };
  const [serviceId, setServiceId] = useState("");
  const [versions, setVersions] = useState<McpVersion[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [gatewayKey, setGatewayKey] = useState("");
  const [gatewayTool, setGatewayTool] = useState("");
  const [gatewayArgs, setGatewayArgs] = useState("{}");
  const [gatewayResult, setGatewayResult] = useState("");
  const [uploading, setUploading] = useState(false);
  const [envText, setEnvText] = useState("{}");
  const [selected, setSelected] = useState<McpService | null>(null);
  const { busy, error: actionError, setError: setActionError, run } = useAsyncAction();
  const [serviceName, setServiceName] = useState("");

  const saveEnvironment = () => {
    if (!selected) return;
    let parsed: Record<string, string | null>;
    try {
      const value = JSON.parse(envText) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("环境变量必须是 JSON 对象");
      }
      parsed = value as Record<string, string | null>;
      for (const [key, val] of Object.entries(parsed)) {
        if (val !== null && typeof val !== "string") {
          throw new Error(`环境变量 ${key} 的值必须是字符串或 null`);
        }
      }
    } catch (e) {
      setActionError(`环境变量 JSON 无效：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    run("env", async () => {
      const env = await getServiceEnvironment(selected.id);
      await updateServiceEnvironment(selected.id, env.revision, parsed);
      services.reload();
    });
  };

  const loadVersions = async (id: string) => {
    setServiceId(id);
    setVersionsLoading(true);
    setVersionsError(null);
    try {
      setVersions(await listVersions(id));
    } catch (e) {
      setVersionsError(e instanceof Error ? e.message : String(e));
    } finally {
      setVersionsLoading(false);
    }
  };

  return (
    <WorkspaceScreen title="MCP 工具" description="构建、发布并治理可被 Agent 安全调用的工具服务。">
      <ErrorText message={actionError} />
      <Card>
        <Sub>新建服务</Sub>
        <Field label="名称" value={newName} onChange={setNewName} placeholder="demo-service" />
        <Field label="Slug" value={newSlug} onChange={setNewSlug} placeholder="demo" />
        <Btn
          title={busy === "create-service" ? "创建中…" : "创建服务"}
          disabled={busy !== null || !newName.trim() || !newSlug.trim()}
          onPress={() => {
            run("create-service", async () => {
              try {
                await createService({ name: newName.trim(), slug: newSlug.trim() });
                setNewName("");
                setNewSlug("");
                services.reload();
              } catch (e) {
                setVersionsError(e instanceof Error ? e.message : String(e));
                throw e;
              }
            });
          }}
        />
      </Card>
      <Card>
        <Sub>服务列表</Sub>
        {services.loading ? <Loading /> : null}
        <ErrorText message={services.error} onRetry={services.reload} />
        {(services.data ?? []).map((s) => (
          <Surface
            key={s.id}
            elevation={0}
            style={{
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.outlineVariant,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Icon source="api" size={20} color={theme.colors.primary} />
              <Text variant="titleSmall" style={{ flex: 1 }} numberOfLines={1}>
                {s.name}
              </Text>
              <Chip compact>{s.status}</Chip>
            </View>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
            >
              {s.slug}
            </Text>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              <Btn
                title={busy === `versions-${s.id}` ? "加载中…" : "版本"}
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  run(`versions-${s.id}`, async () => {
                    setSelected(s);
                    setServiceName(s.name);
                    await loadVersions(s.id);
                  });
                }}
              />
              <Btn
                title="环境变量"
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  run(`env-${s.id}`, async () => {
                    const env = await getServiceEnvironment(s.id);
                    setSelected(s);
                    setServiceName(s.name);
                    setEnvText(
                      JSON.stringify(
                        Object.fromEntries(Object.keys(env.environment).map((k) => [k, ""])),
                        null,
                        2,
                      ),
                    );
                  });
                }}
              />
              <Btn
                title={s.status === "DISABLED" ? "启用" : "禁用"}
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  run(`toggle-${s.id}`, async () => {
                    if (s.status === "DISABLED") {
                      await enableService(s.id, s.revision);
                    } else {
                      await disableService(s.id, s.revision);
                    }
                    services.reload();
                  });
                }}
              />
              <Btn
                title="改名"
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  run(`rename-${s.id}`, async () => {
                    const nextName = serviceName.trim() || `${s.name}-v2`;
                    await updateService(s.id, s.revision, { name: nextName });
                    services.reload();
                  });
                }}
              />
              <Btn
                title="删除"
                kind="danger"
                disabled={busy !== null}
                onPress={() => {
                  run(`delete-${s.id}`, async () => {
                    await deleteService(s.id, s.revision);
                    if (selected?.id === s.id) setSelected(null);
                    services.reload();
                  });
                }}
              />
            </View>
          </Surface>
        ))}
        {selected ? (
          <View style={{ marginTop: 8 }}>
            <Divider style={{ marginVertical: 12 }} />
            <Sub>
              当前服务 {selected.slug} · {serviceId}
            </Sub>
            <Field label="服务名称（用于改名）" value={serviceName} onChange={setServiceName} />
            <Field
              label="环境变量 JSON（null 表示删除该键）"
              value={envText}
              onChange={setEnvText}
              multiline
              hint="只写不回显，保存后下一次调用生效"
            />
            <Btn
              title={busy === "env" ? "保存中…" : "保存环境变量"}
              disabled={busy !== null}
              onPress={saveEnvironment}
            />
            {versionsLoading ? <Loading label="加载版本…" /> : null}
            <ErrorText message={versionsError} />
            {(versions ?? []).map((v) => (
              <Surface
                key={v.id}
                elevation={0}
                style={{
                  padding: 12,
                  marginTop: 8,
                  borderRadius: 12,
                  backgroundColor: theme.colors.surfaceVariant,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text variant="titleSmall" style={{ flex: 1 }}>
                    {`v${v.versionNumber}`}
                  </Text>
                  <Chip compact>{v.status}</Chip>
                </View>
                <Text variant="bodySmall" style={{ marginTop: 2 }}>
                  {`${v.tools.length} tools · ${v.prompts.length} prompts`}
                </Text>
                <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                  <Btn
                    title={uploading ? "上传中…" : "上传代码包"}
                    kind="ghost"
                    disabled={uploading || busy !== null}
                    onPress={() => {
                      setUploading(true);
                      setVersionsError(null);
                      void (async () => {
                        try {
                          const picked = await pickDocuments({
                            multiple: false,
                            mimeTypes: ["application/zip"],
                          });
                          const file = picked[0];
                          if (!file) return;
                          await uploadArtifact(selected.id, v.id, v.revision, {
                            name: file.name,
                            size: file.size,
                            sha256: sha256DigestOf(file.data),
                            contentType: "application/zip",
                            data: file.data,
                          });
                          await loadVersions(selected.id);
                        } catch (e) {
                          setVersionsError(e instanceof Error ? e.message : String(e));
                        } finally {
                          setUploading(false);
                        }
                      })();
                    }}
                  />
                  <Btn
                    title="校验"
                    kind="ghost"
                    disabled={busy !== null}
                    onPress={() => {
                      run(`validate-${v.id}`, async () => {
                        const nv = await validateVersion(selected.id, v.id, v.revision);
                        setVersions((prev) => (prev ?? []).map((x) => (x.id === nv.id ? nv : x)));
                      });
                    }}
                  />
                  <Btn
                    title="构建"
                    kind="ghost"
                    disabled={busy !== null}
                    onPress={() => {
                      run(`build-${v.id}`, async () => {
                        await buildVersion(selected.id, v.id, v.revision);
                        builds.reload();
                      });
                    }}
                  />
                  <Btn
                    title="发布"
                    kind="ghost"
                    disabled={busy !== null}
                    onPress={() => {
                      run(`publish-${v.id}`, async () => {
                        await publishVersion(selected.id, v.id, v.revision);
                        void loadVersions(selected.id);
                        services.reload();
                      });
                    }}
                  />
                  <Btn
                    title="回滚"
                    kind="ghost"
                    disabled={busy !== null}
                    onPress={() => {
                      run(`rollback-${v.id}`, async () => {
                        await rollbackVersion(selected.id, v.id, v.revision);
                        await loadVersions(selected.id);
                      });
                    }}
                  />
                  <Btn
                    title="分叉草稿"
                    kind="ghost"
                    disabled={busy !== null}
                    onPress={() => {
                      run(`fork-${v.id}`, async () => {
                        await forkDraftVersion(selected.id, v.id);
                        await loadVersions(selected.id);
                      });
                    }}
                  />
                  <Btn
                    title="改限制"
                    kind="ghost"
                    disabled={busy !== null}
                    onPress={() => {
                      run(`limits-${v.id}`, async () => {
                        await updateVersionLimits(
                          selected.id,
                          v.id,
                          v.revision,
                          v.limits ?? {
                            timeoutMs: 30000,
                            memoryMb: 256,
                            cpuMillis: 500,
                            network: "none",
                          },
                        );
                        await loadVersions(selected.id);
                      });
                    }}
                  />
                  <Btn
                    title="+Tool"
                    kind="ghost"
                    disabled={busy !== null}
                    onPress={() => {
                      run(`add-tool-${v.id}`, async () => {
                        await addTool(selected.id, v.id, v.revision, {
                          name: `tool-${Date.now() % 10000}`,
                          handler: "index.handler",
                          inputSchema: { type: "object" },
                        });
                        await loadVersions(selected.id);
                      });
                    }}
                  />
                  <Btn
                    title="+Prompt"
                    kind="ghost"
                    disabled={busy !== null}
                    onPress={() => {
                      run(`add-prompt-${v.id}`, async () => {
                        await addPrompt(selected.id, v.id, v.revision, {
                          name: `prompt-${Date.now() % 10000}`,
                          arguments: [],
                          messages: [{ role: "user", content: { type: "text", text: "hi" } }],
                        });
                        await loadVersions(selected.id);
                      });
                    }}
                  />
                  {v.tools[0] ? (
                    <Btn
                      title="删首个Tool"
                      kind="danger"
                      disabled={busy !== null}
                      onPress={() => {
                        run(`delete-tool-${v.id}`, async () => {
                          const firstTool = v.tools[0];
                          if (!firstTool) return;
                          await deleteTool(selected.id, v.id, firstTool.id, v.revision);
                          await loadVersions(selected.id);
                        });
                      }}
                    />
                  ) : null}
                  {v.prompts[0] ? (
                    <Btn
                      title="预览首个Prompt"
                      kind="ghost"
                      disabled={busy !== null}
                      onPress={() => {
                        run(`preview-${v.id}`, async () => {
                          const firstPrompt = v.prompts[0];
                          if (!firstPrompt) return;
                          const r = await previewPrompt(selected.id, v.id, firstPrompt.id, {});
                          setGatewayResult(JSON.stringify(r).slice(0, 500));
                        });
                      }}
                    />
                  ) : null}
                  {v.prompts[0] ? (
                    <Btn
                      title="删首个Prompt"
                      kind="danger"
                      disabled={busy !== null}
                      onPress={() => {
                        run(`delete-prompt-${v.id}`, async () => {
                          const firstPrompt = v.prompts[0];
                          if (!firstPrompt) return;
                          await deletePrompt(selected.id, v.id, firstPrompt.id, v.revision);
                          await loadVersions(selected.id);
                        });
                      }}
                    />
                  ) : null}
                  {v.tools.slice(0, 2).map((t) => (
                    <Btn
                      key={t.id}
                      title={`改${t.name}`}
                      kind="ghost"
                      disabled={busy !== null}
                      onPress={() => {
                        run(`update-tool-${t.id}`, async () => {
                          await updateTool(selected.id, v.id, t.id, v.revision, {
                            name: t.name,
                            description: t.description,
                            handler: t.handler,
                            inputSchema: t.inputSchema,
                          });
                          await loadVersions(selected.id);
                        });
                      }}
                    />
                  ))}
                </View>
              </Surface>
            ))}
          </View>
        ) : null}
      </Card>
      <Card>
        <Sub>Gateway 直调（tools/call）</Sub>
        <Field
          label="API Key"
          value={gatewayKey}
          onChange={setGatewayKey}
          secret
          placeholder="mcp_..."
        />
        <Field
          label="serviceSlug/tool"
          value={gatewayTool}
          onChange={setGatewayTool}
          placeholder="demo/echo"
        />
        <Field label="arguments JSON" value={gatewayArgs} onChange={setGatewayArgs} multiline />
        <Btn
          title={busy === "gateway" ? "调用中…" : "调用"}
          disabled={busy !== null}
          onPress={() => {
            const [slug, tool] = gatewayTool.split("/");
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(gatewayArgs) as Record<string, unknown>;
            } catch {
              setGatewayResult("arguments 不是合法 JSON");
              return;
            }
            if (!slug || !tool) {
              setGatewayResult("请填写 serviceSlug/tool");
              return;
            }
            run("gateway", async () => {
              const r = await callGatewayTool({
                serviceSlug: slug,
                apiKey: gatewayKey,
                toolName: tool,
                arguments: args,
              });
              setGatewayResult(JSON.stringify(r).slice(0, 2000));
            });
          }}
        />
        {gatewayResult ? (
          <Surface
            elevation={0}
            style={{
              marginTop: 10,
              padding: 12,
              borderRadius: 12,
              backgroundColor: theme.colors.surfaceVariant,
            }}
          >
            <Text variant="bodySmall" selectable style={{ lineHeight: 19 }}>
              {gatewayResult}
            </Text>
          </Surface>
        ) : null}
      </Card>
      <Card>
        <Sub>构建任务</Sub>
        {builds.loading ? <Loading /> : null}
        <ErrorText message={builds.error} onRetry={builds.reload} />
        <Text>{`共 ${(builds.data ?? []).length} 个`}</Text>
      </Card>
      <Card>
        <Sub>审计</Sub>
        {audits.loading ? <Loading /> : null}
        <ErrorText message={audits.error} onRetry={audits.reload} />
        {(audits.data ?? []).slice(0, 10).map((a) => (
          <View key={a.id} style={{ paddingVertical: 4 }}>
            <Text numberOfLines={1}>{`${a.action} · ${a.outcome} · ${a.statusCode}`}</Text>
            <Btn
              title="详情"
              kind="ghost"
              disabled={busy !== null}
              onPress={() => {
                run(`audit-${a.id}`, async () => {
                  const d = await getAuditEvent(a.id);
                  setGatewayResult(JSON.stringify(d).slice(0, 1000));
                });
              }}
            />
          </View>
        ))}
      </Card>
      <Card>
        <Sub>SLA（24h）</Sub>
        {sla.loading ? <Loading /> : null}
        <ErrorText message={sla.error} onRetry={sla.reload} />
        {sla.data ? (
          <Text>{`calls ${sla.data.totals.calls} · 成功率 ${(sla.data.totals.successRate * 100).toFixed(1)}% · p95 ${sla.data.totals.p95DurationMs}ms`}</Text>
        ) : null}
      </Card>
      <Card>
        <Sub>客户端授权</Sub>
        {clients.loading ? <Loading /> : null}
        <ErrorText message={clients.error} onRetry={clients.reload} />
        <Field
          label="新客户端名称"
          value={clientName}
          onChange={setClientName}
          placeholder="mobile-client"
        />
        <Btn
          title="创建客户端"
          kind="ghost"
          disabled={busy !== null || !clientName.trim()}
          onPress={() => {
            run("create-client", async () => {
              try {
                await createClient(clientName.trim());
                setClientName("");
                clients.reload();
              } catch (e) {
                setClientError(e instanceof Error ? e.message : String(e));
                throw e;
              }
            });
          }}
        />
        <ErrorText message={clientError} />
        {freshKey ? (
          <Text style={{ marginTop: 4 }}>{`新 Key（仅显示一次）：${freshKey}`}</Text>
        ) : null}
        {(clients.data ?? []).map((c) => (
          <View
            key={c.id}
            style={{
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.outlineVariant,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Icon source="account-key-outline" size={19} color={theme.colors.primary} />
              <Text variant="titleSmall" style={{ flex: 1 }} numberOfLines={1}>
                {c.name}
              </Text>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {c.id.slice(0, 8)}
              </Text>
            </View>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
              <Btn
                title={openClient?.id === c.id ? "收起" : "管理"}
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  setClientError(null);
                  setFreshKey("");
                  if (openClient?.id === c.id) {
                    setOpenClient(null);
                  } else {
                    setOpenClient(c);
                    run(`client-${c.id}`, async () => {
                      await loadClientDetail(c.id);
                    });
                  }
                }}
              />
              <Btn
                title="发 Key"
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  run(`key-${c.id}`, async () => {
                    try {
                      const r = await createApiKey(c.id, null);
                      setFreshKey(r.rawKey);
                      if (openClient?.id === c.id) void loadClientDetail(c.id);
                    } catch (e) {
                      setClientError(e instanceof Error ? e.message : String(e));
                      throw e;
                    }
                  });
                }}
              />
            </View>
          </View>
        ))}
        {openClient ? (
          <View style={{ marginTop: 8 }}>
            <Sub>{`管理 ${openClient.name}`}</Sub>
            {clientDetailLoading ? <Loading label="加载授权明细…" /> : null}
            <ErrorText message={clientError} />
            <Sub>{`Keys（${clientKeys.length}）`}</Sub>
            {clientKeys.map((k) => (
              <View
                key={k.id}
                style={{ flexDirection: "row", gap: 6, alignItems: "center", paddingVertical: 2 }}
              >
                <Text
                  style={{ flex: 1 }}
                  numberOfLines={1}
                >{`${k.prefix ?? k.id} · ${k.status}${k.expiresAt ? ` · 到期 ${k.expiresAt.slice(0, 10)}` : ""}`}</Text>
                {k.status === "ACTIVE" ? (
                  <Btn
                    title="吊销"
                    kind="danger"
                    disabled={busy !== null}
                    onPress={() => {
                      run(`revoke-key-${k.id}`, async () => {
                        try {
                          await revokeApiKey(openClient.id, k.id);
                          await loadClientDetail(openClient.id);
                        } catch (e) {
                          setClientError(e instanceof Error ? e.message : String(e));
                          throw e;
                        }
                      });
                    }}
                  />
                ) : null}
              </View>
            ))}
            <Sub>{`授权（${clientGrants.length}）`}</Sub>
            {clientGrants.map((g) => (
              <View
                key={g.id}
                style={{ flexDirection: "row", gap: 6, alignItems: "center", paddingVertical: 2 }}
              >
                <Text
                  style={{ flex: 1 }}
                  numberOfLines={1}
                >{`${g.serviceId.slice(0, 8)} · ${g.scopes.join(",")}`}</Text>
                <Btn
                  title="移除"
                  kind="danger"
                  disabled={busy !== null}
                  onPress={() => {
                    run(`grant-${g.id}`, async () => {
                      try {
                        await deleteGrant(openClient.id, g.serviceId);
                        await loadClientDetail(openClient.id);
                      } catch (e) {
                        setClientError(e instanceof Error ? e.message : String(e));
                        throw e;
                      }
                    });
                  }}
                />
              </View>
            ))}
            <Field
              label="授权 serviceId"
              value={grantService}
              onChange={setGrantService}
              placeholder="service id"
            />
            <Btn
              title="授予 tools:list+call"
              kind="ghost"
              disabled={busy !== null || !grantService.trim()}
              onPress={() => {
                run(`grant-service-${openClient.id}`, async () => {
                  try {
                    await upsertGrant(openClient.id, grantService.trim(), {
                      scopes: ["mcp:connect", "tools:list", "tools:call"],
                      promptNames: null,
                      toolNames: null,
                    });
                    setGrantService("");
                    await loadClientDetail(openClient.id);
                  } catch (e) {
                    setClientError(e instanceof Error ? e.message : String(e));
                    throw e;
                  }
                });
              }}
            />
            <Sub>{`配额（${clientQuotas.length}）`}</Sub>
            {clientQuotas.map((q) => (
              <Text
                key={q.id}
                numberOfLines={1}
              >{`${q.serviceId ? q.serviceId.slice(0, 8) : "全局"} · qps ${q.qpsLimit} · 日 ${q.dailyCallLimit}`}</Text>
            ))}
            <View style={{ flexDirection: "row", gap: 6 }}>
              <View style={{ flex: 1 }}>
                <Field label="qps" value={quotaQps} onChange={setQuotaQps} placeholder="10" />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label="日调用"
                  value={quotaDaily}
                  onChange={setQuotaDaily}
                  placeholder="1000"
                />
              </View>
            </View>
            <Btn
              title="保存全局配额"
              kind="ghost"
              disabled={busy !== null}
              onPress={() => {
                run(`quota-${openClient.id}`, async () => {
                  try {
                    await upsertClientQuota(openClient.id, {
                      serviceId: null,
                      qpsLimit: Number(quotaQps) || 10,
                      dailyCallLimit: Number(quotaDaily) || 1000,
                    });
                    await loadClientDetail(openClient.id);
                  } catch (e) {
                    setClientError(e instanceof Error ? e.message : String(e));
                    throw e;
                  }
                });
              }}
            />
            <Sub>用量（近 5 条）</Sub>
            {clientUsage.slice(0, 5).map((u) => (
              <Text key={u.id} numberOfLines={1}>{`${u.toolName} · ${u.status}`}</Text>
            ))}
            <Sub>{`服务市场（${marketplace.length}）`}</Sub>
            {marketplace.slice(0, 10).map((m) => (
              <View
                key={m.id}
                style={{ flexDirection: "row", gap: 6, alignItems: "center", paddingVertical: 2 }}
              >
                <Text
                  style={{ flex: 1 }}
                  numberOfLines={1}
                >{`${m.name} · tools ${m.toolCount ?? "?"}`}</Text>
                <Btn
                  title="订阅"
                  kind="ghost"
                  disabled={busy !== null}
                  onPress={() => {
                    run(`subscribe-${m.id}`, async () => {
                      try {
                        await upsertGrant(openClient.id, m.id, {
                          scopes: ["mcp:connect", "tools:list", "tools:call"],
                          promptNames: null,
                          toolNames: null,
                        });
                        await loadClientDetail(openClient.id);
                      } catch (e) {
                        setClientError(e instanceof Error ? e.message : String(e));
                        throw e;
                      }
                    });
                  }}
                />
              </View>
            ))}
          </View>
        ) : null}
      </Card>
    </WorkspaceScreen>
  );
}
