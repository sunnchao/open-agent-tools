import type { WorkflowNodeData } from "./model.js";

export function ExecutionPolicyEditor({
  data,
  updateConfig,
}: {
  data: WorkflowNodeData;
  updateConfig: (key: string, value: unknown) => void;
}) {
  if (!["rag", "graph", "llm", "mcp"].includes(data.kind)) return null;
  const timeout = Number(
    data.config.timeoutMs ?? (["rag", "graph"].includes(data.kind) ? 15000 : 30000),
  );
  const retry = data.config.retry as { maxRetries: number; delayMs?: number } | undefined;
  return (
    <details className="workflow-execution-policy">
      <summary>高级执行设置</summary>
      <label className="studio-field">
        <span>超时（秒）</span>
        <input
          type="range"
          min={1}
          max={120}
          value={timeout / 1000}
          aria-label="超时滑块"
          onChange={(event) => updateConfig("timeoutMs", Number(event.target.value) * 1000)}
        />
        <input
          type="number"
          aria-label="超时（秒）"
          min={1}
          max={120}
          step={1}
          value={timeout / 1000}
          onChange={(event) =>
            updateConfig("timeoutMs", Math.min(120, Math.max(1, Number(event.target.value))) * 1000)
          }
        />
      </label>
      {data.kind === "llm" ? (
        <p className="field-help">LLM 失败时不自动重试，避免重复计费。</p>
      ) : (
        <>
          <label className="studio-field">
            <span>最多重试</span>
            <select
              value={retry?.maxRetries ?? 0}
              onChange={(event) =>
                updateConfig("retry", { ...retry, maxRetries: Number(event.target.value) })
              }
            >
              {[0, 1, 2, 3].map((value) => (
                <option key={value} value={value}>
                  {value === 0 ? "不重试" : `${value} 次`}
                </option>
              ))}
            </select>
          </label>
          <label className="studio-field">
            <span>首次重试间隔（秒）</span>
            <input
              type="number"
              min={0.1}
              max={10}
              step={0.1}
              value={(retry?.delayMs ?? 500) / 1000}
              onChange={(event) =>
                updateConfig("retry", {
                  maxRetries: retry?.maxRetries ?? 0,
                  delayMs: Math.round(
                    Math.min(10, Math.max(0.1, Number(event.target.value))) * 1000,
                  ),
                })
              }
            />
          </label>
          <p className="field-help">
            仅重试暂时性网络或服务错误，间隔指数递增。工具可能有副作用，请按需开启。
          </p>
        </>
      )}
    </details>
  );
}
