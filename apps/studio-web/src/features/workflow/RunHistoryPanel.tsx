import { Alert, Button, Collapse, Empty, Flex, Select, Spin, Typography } from "antd";
import { useEffect, useState } from "react";
import {
  fetchWorkflowRunEvents,
  fetchWorkflowRuns,
  type WorkflowRunHistory,
  type WorkflowRunRecord,
} from "./api.js";
import { replayWorkflowRun } from "./runHistory.js";
import { RunPreview } from "./RunPreview.js";
import {
  cachedNodesFromEvents,
  prepareResumeCheckpoint,
} from "@open-agent-tools/workflow-contracts";
import { variableNodes } from "./variables.js";
import type { WorkflowSnapshot } from "./types.js";

const statusLabels = { running: "运行中", succeeded: "成功", failed: "失败", stopped: "已停止" };

export function RunHistoryPanel({
  workflowId,
  refreshKey,
  currentGraph,
  resumeDisabled,
  onResume,
}: {
  workflowId: string;
  refreshKey: number;
  currentGraph?: WorkflowSnapshot;
  resumeDisabled?: boolean;
  onResume?: (history: WorkflowRunHistory, nodeId: string) => void;
}) {
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([]);
  const [filter, setFilter] = useState<"all" | WorkflowRunRecord["status"]>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<WorkflowRunHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchWorkflowRuns(workflowId, controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setRuns(items);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "运行历史加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [workflowId, refreshKey, revision]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    setHistory(null);
    void fetchWorkflowRunEvents(workflowId, selectedId, controller.signal)
      .then((item) => {
        if (!controller.signal.aborted) setHistory(item);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setDetailError(reason instanceof Error ? reason.message : "历史轨迹加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [workflowId, selectedId, revision, refreshKey]);

  const shown = runs.filter((run) => filter === "all" || run.status === filter);
  const replay = history ? replayWorkflowRun(history) : null;
  const resumeIssues =
    history && currentGraph
      ? new Map(
          replay?.log.map((item) => {
            try {
              prepareResumeCheckpoint(
                {
                  nodes: variableNodes(currentGraph.nodes),
                  edges: currentGraph.edges.map((edge) => ({
                    ...edge,
                    label: typeof edge.label === "string" ? edge.label : undefined,
                  })),
                },
                {
                  nodes: variableNodes(history.graph.nodes),
                  edges: history.graph.edges.map((edge) => ({
                    ...edge,
                    label: typeof edge.label === "string" ? edge.label : undefined,
                  })),
                },
                item.id,
                cachedNodesFromEvents(history.events),
              );
              return [item.id, null] as const;
            } catch (reason) {
              return [item.id, reason instanceof Error ? reason.message : "缓存不可用"] as const;
            }
          }) ?? [],
        )
      : new Map<string, string | null>();
  return (
    <Flex vertical className="workflow-run-history">
      <Flex className="workflow-run-history-tools">
        <Flex align="center" gap={8} className="workflow-run-history-filter">
          <Typography.Text>状态</Typography.Text>
          <Select
            aria-label="运行历史状态"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "全部" },
              ...Object.entries(statusLabels).map(([value, label]) => ({ value, label })),
            ]}
          />
        </Flex>
        <Button
          className="studio-button secondary"
          type="text"
          htmlType="button"
          disabled={loading || detailLoading}
          onClick={() => setRevision((value) => value + 1)}
        >
          刷新
        </Button>
      </Flex>
      {loading ? <Spin aria-label="正在加载运行历史" /> : null}
      {error ? <Alert type="error" title={error} showIcon /> : null}
      {!loading && !error && !shown.length ? (
        <Empty
          className="run-empty"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            runs.length
              ? "没有符合筛选条件的运行"
              : "尚无运行记录，调试运行与公开 API 调用会保存到这里。"
          }
        />
      ) : null}
      <Flex vertical className="workflow-run-history-list">
        {shown.map((run) => (
          <Button
            key={run.id}
            type="text"
            htmlType="button"
            aria-pressed={selectedId === run.id}
            className={`workflow-run-history-item${selectedId === run.id ? " is-active" : ""}`}
            onClick={() => setSelectedId(run.id)}
          >
            <Flex className="workflow-run-history-heading" justify="space-between" gap={8}>
              <Typography.Text strong>{statusLabels[run.status]}</Typography.Text>
              <Typography.Text type="secondary">
                {new Date(run.createdAt).toLocaleString("zh-CN")}
              </Typography.Text>
            </Flex>
            <Typography.Text type="secondary" className="workflow-run-history-meta">
              {run.source === "studio" ? "编辑器调试" : "公开 API"} · {run.user} ·{" "}
              {run.elapsedTime === null ? "—" : `${run.elapsedTime.toFixed(2)}s`} ·{" "}
              {run.totalTokens} tok
            </Typography.Text>
            <Typography.Text code>{run.id}</Typography.Text>
          </Button>
        ))}
      </Flex>
      {runs.length >= 50 ? (
        <Typography.Paragraph className="field-help">当前展示最近 50 次运行。</Typography.Paragraph>
      ) : null}
      {detailLoading ? <Spin aria-label="正在加载历史轨迹" /> : null}
      {detailError ? <Alert type="error" title={detailError} showIcon /> : null}
      {history && replay ? (
        <Flex vertical className="workflow-run-history-detail">
          <Typography.Title level={5}>
            运行详情 · {statusLabels[history.run.status]}
          </Typography.Title>
          <Typography.Paragraph className="field-help">
            {history.run.versionId ? "已发布版本快照" : "当次调试快照"} · {history.run.totalSteps}{" "}
            步 · {history.run.totalTokens} tok
          </Typography.Paragraph>
          <Collapse
            ghost
            items={[
              {
                key: "inputs",
                label: "入口输入",
                children: (
                  <Typography.Paragraph className="workflow-code-block">
                    {JSON.stringify(history.run.inputs, null, 2)}
                  </Typography.Paragraph>
                ),
              },
            ]}
          />
          <RunPreview
            key={history.run.id}
            nodes={history.graph.nodes}
            edges={history.graph.edges}
            running={false}
            runDisabled
            log={replay.log}
            outputs={replay.outputs}
            onRun={() => {}}
            onStop={() => {}}
            readOnly
            onResume={onResume ? (nodeId) => onResume(history, nodeId) : undefined}
            resumeIssue={(nodeId) => {
              if (!replay?.log.some((item) => item.id === nodeId))
                return "没有可复用的成功节点输出";
              if (resumeDisabled) return "当前正在运行或草稿存在问题，请先处理";
              if (!currentGraph) return "当前草稿尚未加载";
              if (!resumeIssues.has(nodeId)) return "缓存不可用";
              return resumeIssues.get(nodeId) ?? null;
            }}
          />
        </Flex>
      ) : null}
    </Flex>
  );
}
