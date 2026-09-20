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

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
  };

  if (loading && !detail) {
    return <div className="workflow-screen-state">正在加载访问点...</div>;
  }

  if (!detail) {
    return (
      <div className="workflow-screen-state is-error">
        <p>{error ?? "工作流不存在"}</p>
        <button className="studio-button secondary" type="button" onClick={onBack}>
          返回工作流
        </button>
      </div>
    );
  }

  const liveVersion = detail.versions.find((version) => version.id === detail.app.currentVersionId);

  return (
    <section className="workflow-access">
      <header className="workflow-access-header">
        <div>
          <button className="workflow-back-link" type="button" onClick={onBack}>
            <CloseOutlined /> 返回编排
          </button>
          <span className="settings-kicker">ACCESS POINT</span>
          <h1>{detail.app.name}</h1>
        </div>
        <button className="studio-button secondary" type="button" onClick={() => void refresh()}>
          <ReloadOutlined /> 刷新
        </button>
      </header>

      {error ? <div className="workflow-access-alert is-error">{error}</div> : null}
      {rawKey ? (
        <div className="workflow-secret-banner" role="status">
          <div>
            <b>API Key 仅显示一次</b>
            <code>{rawKey}</code>
          </div>
          <button type="button" title="复制 API Key" onClick={() => void copy(rawKey)}>
            <CopyOutlined />
          </button>
        </div>
      ) : null}

      <div className="workflow-access-grid">
        <section className="workflow-access-section workflow-endpoint-section">
          <div className="workflow-access-section-head">
            <div>
              <span>Service API</span>
              <h2>公开运行入口</h2>
            </div>
            <span className={`workflow-live-state${liveVersion ? " is-live" : ""}`}>
              {liveVersion ? <CheckCircleFilled /> : null}
              {liveVersion ? `LIVE · v${liveVersion.versionNumber}` : "尚未发布"}
            </span>
          </div>
          <label className="workflow-copy-field">
            <span>Endpoint</span>
            <code>{endpoint}</code>
            <button type="button" title="复制 Endpoint" onClick={() => void copy(endpoint)}>
              <CopyOutlined />
            </button>
          </label>
          <div className="workflow-code-sample">
            <header>
              <div className="workflow-code-tabs" role="tablist" aria-label="调用示例">
                {(["curl", "javascript", "python"] as const).map((language) => (
                  <button
                    key={language}
                    type="button"
                    role="tab"
                    aria-selected={sampleLanguage === language}
                    className={sampleLanguage === language ? "is-active" : undefined}
                    onClick={() => setSampleLanguage(language)}
                  >
                    {language === "curl"
                      ? "cURL"
                      : language === "javascript"
                        ? "JavaScript"
                        : "Python"}
                  </button>
                ))}
              </div>
              <button
                type="button"
                title="复制调用示例"
                onClick={() => void copy(samples[sampleLanguage])}
              >
                <CopyOutlined />
              </button>
            </header>
            <pre>{samples[sampleLanguage]}</pre>
          </div>
          <a
            className={`studio-button secondary workflow-download${liveVersion ? "" : " is-disabled"}`}
            href={liveVersion ? `/api/workflows/${workflowId}/openapi.json` : undefined}
            download={`${detail.app.slug}.openapi.json`}
            aria-disabled={!liveVersion}
          >
            <DownloadOutlined /> 下载 OpenAPI 3.1
          </a>
        </section>

        <section className="workflow-access-section">
          <div className="workflow-access-section-head">
            <div>
              <span>Credentials</span>
              <h2>API Keys</h2>
            </div>
            <KeyOutlined />
          </div>
          <div className="workflow-key-create">
            <input value={keyName} onChange={(event) => setKeyName(event.target.value)} />
            <label>
              <span>每分钟</span>
              <input
                type="number"
                min={1}
                max={10000}
                value={rateLimit}
                onChange={(event) => setRateLimit(Number(event.target.value) || 1)}
              />
            </label>
            <button
              className="studio-button primary"
              type="button"
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
                  })
                  .catch((reason) =>
                    setError(reason instanceof Error ? reason.message : "API Key 创建失败"),
                  )
                  .finally(() => setCreatingKey(false));
              }}
            >
              <KeyOutlined /> {creatingKey ? "创建中" : "创建 Key"}
            </button>
          </div>
          <div className="workflow-key-list">
            {keys.length === 0 ? <p>暂无 API Key。发布后创建一个服务端调用凭据。</p> : null}
            {keys.map((key) => (
              <article key={key.id} className={key.status === "REVOKED" ? "is-revoked" : ""}>
                <div>
                  <b>{key.name}</b>
                  <code>{key.prefix}</code>
                </div>
                <span>{key.status === "ACTIVE" ? `${key.rateLimitPerMinute}/min` : "已吊销"}</span>
                <button
                  type="button"
                  title="吊销 API Key"
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
                        setError(reason instanceof Error ? reason.message : "API Key 吊销失败"),
                      );
                  }}
                >
                  <DeleteOutlined />
                </button>
              </article>
            ))}
          </div>
        </section>

        <section className="workflow-access-section">
          <div className="workflow-access-section-head">
            <div>
              <span>Versions</span>
              <h2>发布历史</h2>
            </div>
            <RocketOutlined />
          </div>
          <div className="workflow-version-list">
            {detail.versions.length === 0 ? <p>发布后将在这里形成不可变版本。</p> : null}
            {detail.versions.map((version) => {
              const active = detail.app.currentVersionId === version.id;
              return (
                <article key={version.id}>
                  <div>
                    <b>v{version.versionNumber}</b>
                    <span>{new Date(version.createdAt).toLocaleString()}</span>
                    {version.releaseNotes ? <small>{version.releaseNotes}</small> : null}
                  </div>
                  {active ? (
                    <span className="workflow-version-active">LIVE</span>
                  ) : (
                    <button
                      className="studio-button secondary"
                      type="button"
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
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <section className="workflow-access-section">
          <div className="workflow-access-section-head">
            <div>
              <span>Operations</span>
              <h2>最近运行</h2>
            </div>
            <span>{runs.length}</span>
          </div>
          <div className="workflow-run-list">
            {runs.length === 0 ? <p>公开 API 调用后会显示运行状态和指标。</p> : null}
            {runs.slice(0, 12).map((run) => (
              <article key={run.id}>
                <span className={`run-state is-${run.status}`}>{run.status}</span>
                <div>
                  <b>{run.user}</b>
                  <code>{run.id.slice(0, 12)}</code>
                </div>
                <span>{run.elapsedTime === null ? "--" : `${run.elapsedTime.toFixed(2)}s`}</span>
                <span>{run.totalTokens} tok</span>
              </article>
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}
