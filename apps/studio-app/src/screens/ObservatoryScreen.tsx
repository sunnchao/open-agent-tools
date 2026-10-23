import React, { useState } from "react";
import { View } from "react-native";
import { Chip, Divider, Icon, Surface, Text, useTheme } from "react-native-paper";
import {
  fetchObservatoryGraph,
  fetchQueryAuditDetail,
  fetchQueryAudits,
  fetchSchemaSources,
  rebuildObservatoryGraph,
  rerunObservatoryQuery,
  runObservatoryQuery,
  type ObservatoryQueryResult,
} from "../api/observatory";
import { useAsync } from "../hooks/useAsync";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { auditExportPath, downloadExport, type ExportFormat } from "../api/exports";
import { shareExport } from "../lib/files";
import { Btn, Card, ErrorText, Field, Loading, Sub } from "../components/ui";
import { WorkspaceScreen } from "../components/workspaceScreen";

export function ObservatoryScreen() {
  const theme = useTheme();
  const sources = useAsync(fetchSchemaSources);
  const [sourceId, setSourceId] = useState("");
  const [question, setQuestion] = useState("");
  const [progress, setProgress] = useState<string[]>([]);
  const [result, setResult] = useState<ObservatoryQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [graphText, setGraphText] = useState("");
  const audits = useAsync(() => fetchQueryAudits({ limit: 20 }));
  const [auditDetail, setAuditDetail] = useState("");
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportMsg, setExportMsg] = useState("");
  const {
    busy,
    error: actionError,
    setBusy,
    setError: setActionError,
    run: runAction,
  } = useAsyncAction();

  const exportAudits = (format: ExportFormat) => {
    if (exporting) return;
    setExporting(format);
    setExportMsg("");
    void (async () => {
      try {
        const dl = await downloadExport(auditExportPath({}, format), `audits.${format}`);
        const uri = await shareExport(dl);
        setExportMsg(`已导出 ${dl.filename}（${uri.slice(0, 60)}…）`);
      } catch (e) {
        setExportMsg(e instanceof Error ? e.message : String(e));
      } finally {
        setExporting(null);
      }
    })();
  };

  const ask = async (rerun?: { parentAuditId: string; sql: string }) => {
    const sid =
      sourceId || sources.data?.find((s) => s.isDefault)?.id || sources.data?.[0]?.id || "";
    if (!sid && !rerun) {
      setError("请先选择数据源");
      return;
    }
    setError(null);
    setActionError(null);
    setBusy("query");
    setProgress([]);
    setResult(null);
    try {
      const r = rerun
        ? await rerunObservatoryQuery(rerun.parentAuditId, rerun.sql, (e) =>
            setProgress((p) => [...p, `${e.type}`]),
          )
        : await runObservatoryQuery(sid, question, [], (e) =>
            setProgress((p) => [...p, `${e.type}:${e.type === "step" ? e.step.label : ""}`]),
          );
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <WorkspaceScreen title="问数" description="用自然语言查询业务数据，保留 SQL、步骤和审计轨迹。">
      <ErrorText message={actionError} />
      <Card>
        <Sub>数据源</Sub>
        {sources.loading ? <Loading /> : null}
        <ErrorText message={sources.error} onRetry={sources.reload} />
        {(sources.data ?? []).map((s) => (
          <View
            key={s.id}
            style={{
              paddingVertical: 9,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.outlineVariant,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Icon source="database-outline" size={19} color={theme.colors.primary} />
              <Text variant="titleSmall" style={{ flex: 1 }} numberOfLines={1}>
                {s.name}
              </Text>
              {s.isDefault ? <Chip compact>默认</Chip> : null}
            </View>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
            >
              {`${s.connector} · ${s.databaseName ?? "未指定数据库"}`}
            </Text>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 4 }}>
              <Btn
                title={sourceId === s.id ? "已选用" : "选用"}
                kind={sourceId === s.id ? "primary" : "ghost"}
                onPress={() => setSourceId(s.id)}
              />
              <Btn
                title="图谱"
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  runAction(`graph-${s.id}`, async () => {
                    const g = await fetchObservatoryGraph(s.id);
                    setGraphText(
                      `${g.database} · 表 ${g.tables.length} · 实体 ${g.stats.entities}`,
                    );
                  });
                }}
              />
              <Btn
                title="重建"
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  runAction(`rebuild-${s.id}`, async () => {
                    const r = await rebuildObservatoryGraph(s.id);
                    setGraphText(`重建完成 实体${r.stats.entities}`);
                  });
                }}
              />
            </View>
          </View>
        ))}
        <Field
          label="当前 sourceId（留空用默认源）"
          value={sourceId}
          onChange={setSourceId}
          placeholder="source id"
        />
        {graphText ? (
          <Text variant="bodySmall" style={{ marginTop: 8, color: theme.colors.onSurfaceVariant }}>
            {graphText}
          </Text>
        ) : null}
      </Card>
      <Card>
        <Sub>提问</Sub>
        <Field
          label="自然语言问题"
          value={question}
          onChange={setQuestion}
          multiline
          placeholder="例如：上月各渠道订单量？"
        />
        <Btn
          title={busy === "query" ? "正在查询…" : "查询"}
          disabled={busy !== null || (!sourceId && !sources.data?.length)}
          onPress={() => {
            void ask();
          }}
        />
        {progress.length > 0 ? (
          <View style={{ marginTop: 10, gap: 4 }}>
            {progress.slice(-5).map((step, index) => (
              <Text
                key={`${step}-${index}`}
                variant="bodySmall"
                style={{ color: theme.colors.onSurfaceVariant }}
              >
                {`· ${step}`}
              </Text>
            ))}
          </View>
        ) : null}
        <ErrorText message={error} />
        {result ? (
          <Surface
            elevation={0}
            style={{
              marginTop: 12,
              padding: 14,
              borderRadius: 14,
              backgroundColor: theme.colors.surfaceVariant,
            }}
          >
            <Text variant="labelMedium" style={{ marginBottom: 6 }}>
              生成的 SQL
            </Text>
            <Text variant="bodySmall" selectable style={{ lineHeight: 19 }}>
              {result.sql || result.generatedSql || result.executedSql || "(无 SQL)"}
            </Text>
            <Divider style={{ marginVertical: 10 }} />
            <Text
              variant="labelSmall"
              style={{ color: theme.colors.onSurfaceVariant, marginBottom: 6 }}
            >
              {`${(result.rows ?? []).length} 行${result.truncated ? "（截断）" : ""} · ${result.durationMs}ms`}
            </Text>
            {(result.rows ?? []).slice(0, 5).map((row, i) => (
              <Text key={i} variant="bodySmall" numberOfLines={2} style={{ marginTop: 3 }}>
                {JSON.stringify(row).slice(0, 180)}
              </Text>
            ))}
            {result.clarifying ? <Text>{`需澄清：${result.clarifying}`}</Text> : null}
            {result.auditId ? (
              <Btn
                title="重跑该审计 SQL"
                kind="ghost"
                onPress={() => {
                  void ask({
                    parentAuditId: result.auditId!,
                    sql: result.executedSql || result.sql || "",
                  });
                }}
              />
            ) : null}
          </Surface>
        ) : null}
      </Card>
      <Card>
        <Sub>审计日志</Sub>
        {audits.loading ? <Loading /> : null}
        <ErrorText message={audits.error} onRetry={audits.reload} />
        <View style={{ flexDirection: "row", gap: 6, marginBottom: 6 }}>
          <Btn
            title={exporting === "csv" ? "导出中…" : "导出 CSV"}
            kind="ghost"
            disabled={exporting !== null}
            onPress={() => exportAudits("csv")}
          />
          <Btn
            title={exporting === "json" ? "导出中…" : "导出 JSON"}
            kind="ghost"
            disabled={exporting !== null}
            onPress={() => exportAudits("json")}
          />
        </View>
        {exportMsg ? <Text style={{ marginBottom: 6 }}>{exportMsg}</Text> : null}
        {(audits.data?.records ?? []).slice(0, 20).map((a) => (
          <View
            key={a.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingVertical: 7,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.outlineVariant,
            }}
          >
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {a.status}
            </Text>
            <Text variant="bodySmall" numberOfLines={1} style={{ flex: 1 }}>
              {a.question}
            </Text>
            <Btn
              title="回放"
              kind="ghost"
              onPress={() => {
                runAction(`audit-${a.id}`, async () => {
                  const d = await fetchQueryAuditDetail(a.id);
                  setAuditDetail(
                    `${d.record.sql ?? ""}\n行数 ${d.record.resultPreview.length}`.slice(0, 500),
                  );
                });
              }}
            />
          </View>
        ))}
        {auditDetail ? (
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
              {auditDetail}
            </Text>
          </Surface>
        ) : null}
      </Card>
    </WorkspaceScreen>
  );
}
