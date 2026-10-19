import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  List,
  Segmented,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircleFilled,
  CloseOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  KeyOutlined,
  ReloadOutlined,
  RocketOutlined,
} from "../../lib/icons.js";
import {
  createWorkflowKey,
  fetchWorkflow,
  fetchWorkflowRuns,
  revokeWorkflowKey,
  rollbackWorkflow,
  type WorkflowApiKeyRecord,
  type WorkflowDetailRecord,
  type WorkflowRunRecord,
} from "./api.js";

function createAdditionalCodeSamples(endpoint: string) {
  const payload = JSON.stringify(
    {
      inputs: { query: "Hello" },
      response_mode: "streaming",
      user: "external:user-1",
    },
    null,
    2,
  );
  return {
    javascript: `const response = await fetch("${endpoint}", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.WORKFLOW_API_KEY}\`,
    "Content-Type": "application/json",
    "Idempotency-Key": "request-001",
  },
  body: JSON.stringify(${payload}),
});

for await (const chunk of response.body) {
  process.stdout.write(new TextDecoder().decode(chunk));
}`,
    python: `import os
import requests

with requests.post(
    "${endpoint}",
    headers={
        "Authorization": f"Bearer {os.environ['WORKFLOW_API_KEY']}",
        "Idempotency-Key": "request-001",
    },
    json=${payload},
    stream=True,
) as response:
    response.raise_for_status()
    for line in response.iter_lines(decode_unicode=True):
        if line:
            print(line)`,
  };
}

export function WorkflowAccess({
  workflowId,
  onBack,
  onChanged,
}: {
  workflowId: string;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { message } = App.useApp();
  const [detail, setDetail] = useState<WorkflowDetailRecord | null>(null);
  const [keys, setKeys] = useState<WorkflowApiKeyRecord[]>([]);
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [keyName, setKeyName] = useState("External platform");
  const [rateLimit, setRateLimit] = useState(60);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);
  const [sampleLanguage, setSampleLanguage] = useState<"curl" | "javascript" | "python">("curl");

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [workflow, runItems] = await Promise.all([
        fetchWorkflow(workflowId),
        fetchWorkflowRuns(workflowId),
      ]);
      setDetail(workflow.workflow);
      setKeys(workflow.apiKeys);
      setRuns(runItems);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "访问点加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [workflowId]);

  const endpoint = detail ? `${window.location.origin}/v1/workflows/${detail.app.slug}/run` : "";
  const curl = useMemo(
    () =>
      detail
        ? `curl -N ${endpoint} \\\n  -H "Authorization: Bearer $WORKFLOW_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify({ inputs: { query: "Hello" }, response_mode: "streaming", user: "external:user-1" })}'`
        : "",
    [detail, endpoint],
  );
  const samples = useMemo(
    () => ({ curl, ...createAdditionalCodeSamples(endpoint) }),
    [curl, endpoint],
  );

  const copy = async (value: string, label = "已复制") => {
    try {
      await navigator.clipboard.writeText(value);
      void message.success(label);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "复制失败");
    }
  };

  if (loading && !detail) {
    return (
      <Flex justify="center" style={{ padding: 64 }}>
        <Spin tip="正在加载访问点..." />
      </Flex>
    );
  }

  if (!detail) {
    return (
      <Flex vertical gap={12} align="center" style={{ padding: 64 }}>
        <Alert type="error" showIcon message={error ?? "工作流不存在"} />
        <Button onClick={onBack}>返回工作流</Button>
      </Flex>
    );
  }

  const liveVersion = detail.versions.find((version) => version.id === detail.app.currentVersionId);

  return (
    <Flex vertical gap={12} style={{ height: "100%", overflow: "auto", padding: 16 }}>
      <Card size="small">
        <Flex align="center" justify="space-between" gap={12} wrap>
          <Flex vertical gap={2} style={{ minWidth: 0 }}>
            <Flex gap={8} align="center">
              <Button type="text" size="small" icon={<CloseOutlined />} onClick={onBack}>
                返回编排
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 10, letterSpacing: 2 }}>
                ACCESS POINT
              </Typography.Text>
            </Flex>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {detail.app.name}
            </Typography.Title>
          </Flex>
          <Tooltip title="刷新">
            <Button icon={<ReloadOutlined spin={loading} />} onClick={() => void refresh()} aria-label="刷新" />
          </Tooltip>
        </Flex>
      </Card>

      {error ? <Alert type="error" showIcon message={error} role="alert" /> : null}
      {rawKey ? (
        <Alert
          type="warning"
          showIcon
          role="status"
          message="API Key 仅显示一次"
          description={
            <Typography.Paragraph code copyable style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>
              {rawKey}
            </Typography.Paragraph>
          }
        />
      ) : null}

      <Flex gap={12} align="start" wrap>
        <Card
          size="small"
          title="公开运行入口"
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Service API
            </Typography.Text>
          }
          style={{ flex: 1, minWidth: 320 }}
          actions={[
            <Button
              key="openapi"
              type="link"
              size="small"
              icon={<DownloadOutlined />}
              disabled={!liveVersion}
              href={liveVersion ? `/api/workflows/${workflowId}/openapi.json` : undefined}
              download={`${detail.app.slug}.openapi.json`}
              aria-disabled={!liveVersion}
            >
              下载 OpenAPI 3.1
            </Button>,
          ]}
        >
          <Flex gap={8} align="center" style={{ marginBottom: 12 }}>
            {liveVersion ? (
              <Tag icon={<CheckCircleFilled />} color="success">
                LIVE · v{liveVersion.versionNumber}
              </Tag>
            ) : (
              <Tag>尚未发布</Tag>
            )}
          </Flex>
          <Form.Item label="Endpoint" style={{ marginBottom: 12 }}>
            <Input
              readOnly
              value={endpoint}
              addonAfter={
                <Tooltip title="复制 Endpoint">
                  <Button
                    type="text"
                    size="small"
                    icon={<CopyOutlined />}
                    aria-label="复制 Endpoint"
                    onClick={() => void copy(endpoint)}
                  />
                </Tooltip>
              }
            />
          </Form.Item>
          <Flex justify="space-between" align="center" style={{ marginBottom: 8 }}>
            <Segmented
              aria-label="调用示例"
              value={sampleLanguage}
              onChange={(value) => setSampleLanguage(value as typeof sampleLanguage)}
              options={[
                { value: "curl", label: "cURL" },
                { value: "javascript", label: "JavaScript" },
                { value: "python", label: "Python" },
              ]}
            />
            <Tooltip title="复制调用示例">
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                aria-label="复制调用示例"
                onClick={() => void copy(samples[sampleLanguage])}
              />
            </Tooltip>
          </Flex>
          <Typography.Paragraph
            code
            copyable
            style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}
          >
            {samples[sampleLanguage]}
          </Typography.Paragraph>
        </Card>

        <Card
          size="small"
          title="API Keys"
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Credentials
            </Typography.Text>
          }
          style={{ flex: 1, minWidth: 320 }}
        >
          <Form layout="vertical" preserve={false}>
            <Form.Item label="Key 名称" style={{ marginBottom: 8 }}>
              <Input value={keyName} onChange={(event) => setKeyName(event.target.value)} />
            </Form.Item>
            <Form.Item label="每分钟限流" style={{ marginBottom: 8 }}>
              <InputNumber
                min={1}
                max={10000}
                value={rateLimit}
                onChange={(value) => setRateLimit(Number(value) || 1)}
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Button
              block
              type="primary"
              icon={<KeyOutlined />}
              loading={creatingKey}
              disabled={creatingKey || !liveVersion}
              onClick={() => {
                setCreatingKey(true);
                setError(null);
                void createWorkflowKey(workflowId, {
                  name: keyName,
                  rateLimitPerMinute: rateLimit,
                })
                  .then((created) => {
                    setRawKey(created.rawKey);
                    setKeys((current) => [created.key, ...current]);
                    void message.success("API Key 已创建");
                  })
                  .catch((reason) =>
                    setError(reason instanceof Error ? reason.message : "API Key 创建失败"),
                  )
                  .finally(() => setCreatingKey(false));
              }}
            >
              {creatingKey ? "创建中" : "创建 Key"}
            </Button>
          </Form>
          {keys.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无 API Key。发布后创建一个服务端调用凭据。"
              style={{ marginTop: 12 }}
            />
          ) : (
            <List
              size="small"
              style={{ marginTop: 12 }}
              dataSource={keys}
              renderItem={(key) => (
                <List.Item
                  actions={[
                    <Tooltip key="revoke" title="吊销 API Key">
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label="吊销 API Key"
                        disabled={key.status !== "ACTIVE"}
                        onClick={() => {
                          void revokeWorkflowKey(workflowId, key.id)
                            .then(() =>
                              setKeys((current) =>
                                current.map((item) =>
                                  item.id === key.id ? { ...item, status: "REVOKED" } : item,
                                ),
                              ),
                            )
                            .catch((reason) =>
                              setError(
                                reason instanceof Error ? reason.message : "API Key 吊销失败",
                              ),
                            );
                        }}
                      />
                    </Tooltip>,
                  ]}
                >
                  <List.Item.Meta
                    title={key.name}
                    description={`${key.prefix} · ${key.status === "ACTIVE" ? `${key.rateLimitPerMinute}/min` : "已吊销"}`}
                  />
                </List.Item>
              )}
            />
          )}
        </Card>

        <Card
          size="small"
          title="发布历史"
          extra={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Versions
            </Typography.Text>
          }
          style={{ flex: 1, minWidth: 300 }}
        >
          {detail.versions.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="发布后将在这里形成不可变版本。"
            />
          ) : (
            <List
              size="small"
              dataSource={detail.versions}
              renderItem={(version) => {
                const active = detail.app.currentVersionId === version.id;
                return (
                  <List.Item
                    actions={[
                      active ? (
                        <Tag key="live" icon={<RocketOutlined />} color="success">
                          LIVE
                        </Tag>
                      ) : (
                        <Button
                          key="rollback"
                          type="link"
                          size="small"
                          onClick={() => {
                            void rollbackWorkflow(workflowId, version.id)
                              .then((workflow) => {
                                setDetail(workflow);
                                onChanged();
                              })
                              .catch((reason) =>
                                setError(reason instanceof Error ? reason.message : "回滚失败"),
                              );
                          }}
                        >
                          回滚
                        </Button>
                      ),
                    ]}
                  >
                    <List.Item.Meta
                      title={`v${version.versionNumber}`}
                      description={`${new Date(version.createdAt).toLocaleString()}${version.releaseNotes ? ` · ${version.releaseNotes}` : ""}`}
                    />
                  </List.Item>
                );
              }}
            />
          )}
        </Card>

        <Card
          size="small"
          title="最近运行"
          extra={<Tag>{runs.length}</Tag>}
          style={{ flex: 1, minWidth: 300 }}
        >
          {runs.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="公开 API 调用后会显示运行状态和指标。"
            />
          ) : (
            <List
              size="small"
              dataSource={runs.slice(0, 12)}
              renderItem={(run) => (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Flex gap={8} align="center">
                        <Tag
                          color={
                            run.status === "succeeded"
                              ? "success"
                              : run.status === "failed"
                                ? "error"
                                : run.status === "running"
                                  ? "processing"
                                  : undefined
                          }
                        >
                          {run.status}
                        </Tag>
                        <Typography.Text strong>{run.user}</Typography.Text>
                      </Flex>
                    }
                    description={`${run.id.slice(0, 12)} · ${
                      run.elapsedTime === null ? "--" : `${run.elapsedTime.toFixed(2)}s`
                    } · ${run.totalTokens} tok`}
                  />
                </List.Item>
              )}
            />
          )}
        </Card>
      </Flex>
    </Flex>
  );
}
