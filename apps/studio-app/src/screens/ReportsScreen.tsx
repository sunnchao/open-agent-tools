import React, { useState } from "react";
import { View } from "react-native";
import { Chip, Icon, Surface, Text, useTheme } from "react-native-paper";
import {
  createReport,
  deleteReport,
  getReport,
  listReports,
  listSchemaSources,
  runReportNow,
  updateReport,
  type SchemaSourceOption,
} from "../api/misc";
import { useAsync } from "../hooks/useAsync";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { Btn, Card, ErrorText, Field, Loading, Sub } from "../components/ui";
import { WorkspaceScreen } from "../components/workspaceScreen";

export function ReportsScreen() {
  const theme = useTheme();
  const reports = useAsync(listReports);
  const [name, setName] = useState("");
  const [question, setQuestion] = useState("");
  const [detail, setDetail] = useState("");
  const { busy, error: actionError, run } = useAsyncAction();
  const sources = useAsync<SchemaSourceOption[]>(listSchemaSources);

  return (
    <WorkspaceScreen
      title="定时报表"
      description="把稳定的数据问题变成可按时交付、可追踪结果的报表。"
    >
      <ErrorText message={actionError} />
      <Card>
        <Sub>新建报表（每日）</Sub>
        <Field label="名称" value={name} onChange={setName} placeholder="日报" />
        <Field
          label="问题"
          value={question}
          onChange={setQuestion}
          multiline
          placeholder="用自然语言描述报表口径"
        />
        <Btn
          title={busy === "create" ? "创建中…" : "创建报表"}
          disabled={busy !== null || !name.trim() || !question.trim()}
          onPress={() => {
            run("create", async () => {
              await createReport({
                name: name.trim(),
                question,
                sourceId: sources.data?.[0]?.id ?? null,
                frequency: "daily",
                time: "08:00",
                weekday: 1,
                enabled: true,
              });
              setName("");
              setQuestion("");
              reports.reload();
            });
          }}
        />
      </Card>
      <Card>
        <Sub>报表列表</Sub>
        {reports.loading ? <Loading /> : null}
        <ErrorText message={reports.error} onRetry={reports.reload} />
        {(reports.data?.reports ?? []).map((r) => (
          <View
            key={r.id}
            style={{
              paddingVertical: 10,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.outlineVariant,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Icon
                source={r.enabled ? "calendar-check-outline" : "calendar-remove-outline"}
                size={19}
                color={r.enabled ? theme.colors.primary : theme.colors.onSurfaceVariant}
              />
              <Text variant="titleSmall" style={{ flex: 1 }} numberOfLines={1}>
                {r.name}
              </Text>
              <Chip compact>{r.lastStatus ?? "未运行"}</Chip>
            </View>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant, marginTop: 3 }}
            >
              {`${r.schedule.frequency} · ${r.schedule.time} · ${r.enabled ? "已启用" : "已停用"}`}
            </Text>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
              <Btn
                title="详情"
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  run(`detail-${r.id}`, async () => {
                    const d = await getReport(r.id);
                    setDetail(`运行 ${d.runs.length} 次 · 最近 ${d.runs[0]?.status ?? "无"}`);
                  });
                }}
              />
              <Btn
                title={busy === `run-${r.id}` ? "运行中…" : "立即运行"}
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  run(`run-${r.id}`, async () => {
                    const result = await runReportNow(r.id);
                    setDetail(`运行完成 · ${result.run.status}`);
                    reports.reload();
                  });
                }}
              />
              <Btn
                title={r.enabled ? "停用" : "启用"}
                kind="ghost"
                disabled={busy !== null}
                onPress={() => {
                  run(`toggle-${r.id}`, async () => {
                    await updateReport(r.id, {
                      name: r.name,
                      question: r.question,
                      sourceId: r.sourceId,
                      frequency: r.schedule.frequency,
                      time: r.schedule.time,
                      weekday: r.schedule.weekday ?? 1,
                      enabled: !r.enabled,
                    });
                    reports.reload();
                  });
                }}
              />
              <Btn
                title="删除"
                kind="danger"
                disabled={busy !== null}
                onPress={() => {
                  run(`delete-${r.id}`, async () => {
                    await deleteReport(r.id);
                    reports.reload();
                  });
                }}
              />
            </View>
          </View>
        ))}
        {detail ? (
          <Surface
            elevation={0}
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 12,
              backgroundColor: theme.colors.surfaceVariant,
            }}
          >
            <Text variant="bodySmall">{detail}</Text>
          </Surface>
        ) : null}
      </Card>
    </WorkspaceScreen>
  );
}
