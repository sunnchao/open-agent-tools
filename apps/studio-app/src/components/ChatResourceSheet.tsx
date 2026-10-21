import React from "react";
import { View } from "react-native";
import { Divider, Text, useTheme } from "react-native-paper";
import type { ChatResourceBinding, McpToolBinding } from "../lib/types";
import type { ResourceCatalog } from "../api/misc";
import { Btn, CheckRow, ErrorText, Loading, Sheet, Stepper, Sub } from "./ui";

function sameTool(left: McpToolBinding, right: McpToolBinding): boolean {
  return left.serviceSlug === right.serviceSlug && left.toolName === right.toolName;
}

export function ChatResourceSheet(props: {
  visible: boolean;
  catalog: ResourceCatalog | null;
  loading: boolean;
  error: string | null;
  resources: ChatResourceBinding;
  onClose: () => void;
  onRefresh: () => void;
  onChange: (resources: ChatResourceBinding) => void;
  onOpenSettings?: () => void;
}) {
  const theme = useTheme();
  const { visible, catalog, loading, error, resources, onClose, onRefresh, onChange } = props;
  const availableSources = new Set(catalog?.rag.sources.map((i) => i.source) ?? []);
  const missingSources = resources.rag.sources.filter((s) => !availableSources.has(s));
  const availableSql = new Set(catalog?.sql?.sources.map((s) => s.id) ?? []);
  const missingSql = resources.sqlSources.filter((id) => !availableSql.has(id));
  const availableTools = new Set(
    catalog?.mcp.services.flatMap((s) => s.tools.map((t) => `${s.serviceSlug}:${t.name}`)) ?? [],
  );
  const missingTools = resources.mcpTools.filter(
    (t) => !availableTools.has(`${t.serviceSlug}:${t.toolName}`),
  );
  const toggleSource = (source: string, checked: boolean) => {
    const sources = checked
      ? [...resources.rag.sources, source]
      : resources.rag.sources.filter((i) => i !== source);
    onChange({ ...resources, rag: { ...resources.rag, sources } });
  };
  const toggleSql = (id: string, checked: boolean) => {
    const sqlSources = checked
      ? [...resources.sqlSources, id]
      : resources.sqlSources.filter((i) => i !== id);
    onChange({ ...resources, sqlSources });
  };
  const toggleTool = (binding: McpToolBinding, checked: boolean) => {
    const mcpTools = checked
      ? [...resources.mcpTools, binding]
      : resources.mcpTools.filter((i) => !sameTool(i, binding));
    onChange({ ...resources, mcpTools });
  };
  return (
    <Sheet visible={visible} title="对话资源" onClose={onClose}>
      <Sub>配置仅对当前会话生效，凭据由 Agent Server 管理。</Sub>
      <Btn
        title={loading ? "刷新中…" : "刷新资源目录"}
        kind="ghost"
        onPress={onRefresh}
        disabled={loading}
      />
      <ErrorText message={error} onRetry={onRefresh} />
      {loading && !catalog ? (
        <Loading />
      ) : (
        <View>
          <Sub>{`RAG 文档（${resources.rag.sources.length}）· 回答前检索已挂载文档`}</Sub>
          {catalog?.rag.error ? <ErrorText message={catalog.rag.error} /> : null}
          {missingSources.map((s) => (
            <CheckRow
              key={s}
              checked
              title={s}
              desc="文档已失效，取消勾选可移除挂载"
              missing
              onToggle={(n) => toggleSource(s, n)}
            />
          ))}
          {(catalog?.rag.sources.length ?? 0) === 0 && missingSources.length === 0 ? (
            <Sub>暂无可挂载文档</Sub>
          ) : (
            (catalog?.rag.sources ?? []).map((item) => (
              <CheckRow
                key={item.source}
                checked={resources.rag.sources.includes(item.source)}
                title={item.source}
                desc={`${item.chunks} 个分块`}
                onToggle={(n) => toggleSource(item.source, n)}
              />
            ))
          )}
          <Divider style={{ marginVertical: 16 }} />
          <Sub>{`Top-K ${resources.rag.topK} · 每次回答最多引用的分块数`}</Sub>
          <Stepper
            value={resources.rag.topK}
            min={1}
            max={20}
            onChange={(topK) => onChange({ ...resources, rag: { ...resources.rag, topK } })}
          />

          <Divider style={{ marginVertical: 16 }} />
          <Sub>{`SQL 问数（${resources.sqlSources.length}）· 复用问数的查询与审计`}</Sub>
          {catalog?.sql?.error ? <ErrorText message={catalog.sql.error} /> : null}
          {missingSql.map((id) => (
            <CheckRow
              key={id}
              checked
              title={id}
              desc="数据源已停用或删除，取消勾选可移除绑定"
              missing
              onToggle={(n) => toggleSql(id, n)}
            />
          ))}
          {(catalog?.sql?.sources.length ?? 0) === 0 && missingSql.length === 0 ? (
            <Sub>暂无可用的 SQL 数据源，请先在「数据源管理」中配置</Sub>
          ) : (
            (catalog?.sql?.sources ?? []).map((s) => (
              <CheckRow
                key={s.id}
                checked={resources.sqlSources.includes(s.id)}
                disabled={!resources.sqlSources.includes(s.id) && resources.sqlSources.length >= 20}
                title={`${s.name}${s.isDefault ? "（默认）" : ""}`}
                desc={s.connector === "postgresql" ? "PostgreSQL" : "MySQL"}
                onToggle={(n) => toggleSql(s.id, n)}
              />
            ))
          )}

          <Divider style={{ marginVertical: 16 }} />
          <Sub>{`MCP Tools（${resources.mcpTools.length}）· 允许模型按需真实调用`}</Sub>
          {catalog && !catalog.mcp.configured ? (
            <View style={{ marginBottom: 8 }}>
              <Text style={{ color: theme.colors.onSurfaceVariant }}>尚未配置 MCP Gateway</Text>
              {props.onOpenSettings ? (
                <Btn title="前往设置" kind="ghost" onPress={props.onOpenSettings} />
              ) : null}
            </View>
          ) : null}
          {catalog?.mcp.error ? <ErrorText message={catalog.mcp.error} /> : null}
          {missingTools.map((t) => (
            <CheckRow
              key={`${t.serviceSlug}:${t.toolName}`}
              checked
              title={`${t.serviceSlug} / ${t.toolName}`}
              desc="Tool 已失效，取消勾选可移除绑定"
              missing
              onToggle={(n) => toggleTool(t, n)}
            />
          ))}
          {(catalog?.mcp.services.length ?? 0) === 0 && missingTools.length === 0 ? (
            <Sub>暂无已授权 Tool</Sub>
          ) : (
            (catalog?.mcp.services ?? []).map((s) => (
              <View key={s.serviceSlug}>
                <Sub>{s.serviceSlug}</Sub>
                {s.tools.map((t) => {
                  const binding = { serviceSlug: s.serviceSlug, toolName: t.name };
                  return (
                    <CheckRow
                      key={t.name}
                      checked={resources.mcpTools.some((i) => sameTool(i, binding))}
                      title={t.name}
                      desc={t.description ?? "无描述"}
                      onToggle={(n) => toggleTool(binding, n)}
                    />
                  );
                })}
              </View>
            ))
          )}
        </View>
      )}
    </Sheet>
  );
}
