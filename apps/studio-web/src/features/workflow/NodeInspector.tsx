import { variableIssues, type VariableIssue } from "@open-agent-tools/workflow-contracts";
import { variableNodes } from "./variables.js";
import { RunVariablesEditor } from "./RunVariablesEditor.js";
import { TemplateField } from "./TemplateField.js";
import { ExecutionPolicyEditor } from "./ExecutionPolicyEditor.js";
import { nodeInputs } from "./model.js";
import { useEffect, useState } from "react";
import { PlayCircleOutlined, ReloadOutlined } from "../../lib/icons.js";
import type { ProviderMetadata } from "../../features/providers/api.js";
import type { ResourceCatalog } from "../../features/resources/api.js";
import type { WorkflowNodeTestResult } from "../../lib/api.js";
import type { WorkflowConfigValue } from "./model.js";
import { iconByKind, palette } from "./palette.js";
import { VariableBindingsEditor } from "./VariableBindingsEditor.js";
import { NodeTestResultPanel } from "./NodeTestResultPanel.js";
import type { WorkflowNode } from "./types.js";
import type { Edge } from "@xyflow/react";

export function NodeInspector({
  node,
  nodes,
  edges,
  providers,
  providerError,
  updateEdgeLabel,
  updateNode,
  updateConfig,
  renameVariable,
  onManageVariables,
  catalog,
  loading,
  resourceError,
  refreshResources,
  testResult,
  testPending,
  testDisabled,
  onTest,
  onRepairReference,
}: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  edges: Edge[];
  providers: ProviderMetadata[];
  providerError: string | null;
  updateEdgeLabel: (edgeId: string, label: string) => void;
  updateNode: (patch: Partial<WorkflowNode["data"]>) => void;
  updateConfig: (key: string, value: WorkflowConfigValue) => void;
  renameVariable: (
    kind: "inputs" | "outputs" | "runVariables",
    index: number,
    name: string,
  ) => void;
  onManageVariables: () => void;
  catalog: ResourceCatalog | null;
  loading: boolean;
  resourceError: string | null;
  refreshResources: () => void;
  testResult?: WorkflowNodeTestResult;
  testPending: boolean;
  testDisabled: boolean;
  onTest: () => void;
  onRepairReference?: (issue: VariableIssue, replacement: string) => void;
}) {
  const { data } = node;
  const [activeView, setActiveView] = useState<"config" | "run">("config");
  useEffect(() => setActiveView("config"), [node.id]);
  useEffect(() => {
    if (testResult) setActiveView("run");
  }, [testResult]);
  const ragSources = Array.isArray(data.config.sources) ? data.config.sources : [];
  const selectedService = catalog?.mcp.services.find(
    (service) => service.serviceSlug === String(data.config.serviceSlug),
  );
  const selectedTool = selectedService?.tools.find(
    (tool) => tool.name === String(data.config.toolName),
  );
  const availableRagSources = new Set(catalog?.rag.sources.map((source) => source.source) ?? []);
  const missingRagSources = ragSources.filter((source) => !availableRagSources.has(source));
  return (
    <div className="inspector-content node-inspector-content">
      <div className="inspector-title-row">
        <span className={`node-icon kind-${data.kind}`}>{iconByKind[data.kind]}</span>
        <div className="inspector-title-copy">
          <h2>{data.label}</h2>
          <p>{palette.find((item) => item.kind === data.kind)?.group}</p>
        </div>
        <button
          className="node-test-command"
          type="button"
          disabled={testDisabled}
          title="单独测试当前节点"
          onClick={onTest}
        >
          <PlayCircleOutlined /> {testPending ? "测试中" : "测试运行"}
        </button>
      </div>
      <div className="node-inspector-tabs" role="tablist" aria-label="节点检查器视图">
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "config"}
          className={activeView === "config" ? "is-active" : undefined}
          onClick={() => setActiveView("config")}
        >
          配置
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeView === "run"}
          className={activeView === "run" ? "is-active" : undefined}
          onClick={() => setActiveView("run")}
        >
          上次运行
          {testResult ? (
            <span className={`test-tab-dot is-${testResult.status}`} aria-hidden="true" />
          ) : null}
        </button>
      </div>
      {activeView === "run" ? (
        <NodeTestResultPanel
          result={testResult}
          pending={testPending}
          disabled={testDisabled}
          onTest={onTest}
        />
      ) : (
        <>
          <label className="studio-field">
            <span>节点名称</span>
            <input
              value={data.label}
              onChange={(event) => updateNode({ label: event.target.value })}
            />
          </label>
          <label className="studio-field">
            <span>说明</span>
            <input
              value={data.description}
              onChange={(event) => updateNode({ description: event.target.value })}
            />
          </label>
          <div className="inspector-section-title">参数</div>
          <ExecutionPolicyEditor data={data} updateConfig={updateConfig} />
          {data.kind === "start" ? (
            <RunVariablesEditor
              node={node}
              nodes={nodes}
              updateConfig={updateConfig}
              rename={renameVariable}
            />
          ) : (
            <VariableBindingsEditor
              node={node}
              nodes={nodes}
              edges={edges}
              updateConfig={updateConfig}
              rename={renameVariable}
              onManageVariables={onManageVariables}
              sample={testResult?.status === "success" ? testResult.result : undefined}
            />
          )}
          {variableIssues(variableNodes(nodes))
            .filter((issue) => issue.nodeId === node.id)
            .map((issue, index) => (
              <div className="node-resource-state is-error" key={`${issue.code}-${index}`}>
                <span>{issue.message}</span>
                {onRepairReference && issue.reference && issue.suggestions?.length
                  ? issue.suggestions.map((suggestion) => (
                      <button
                        key={`${issue.reference}-${suggestion}`}
                        type="button"
                        className="variable-text-button"
                        onClick={() => onRepairReference(issue, suggestion)}
                      >
                        改为 {suggestion}
                      </button>
                    ))
                  : null}
              </div>
            ))}
          {providerError && data.kind === "llm" ? (
            <div className="node-resource-state is-error">{providerError}</div>
          ) : null}
          {resourceError && (data.kind === "rag" || data.kind === "mcp") ? (
            <div className="node-resource-state is-error">{resourceError}</div>
          ) : null}
          {data.kind === "mcp" && catalog && !catalog.mcp.configured ? (
            <div className="node-resource-state is-error">
              Agent Server 尚未配置 MCP Gateway API Key
            </div>
          ) : null}
          {data.kind === "rag" ? (
            <>
              <div className="studio-field">
                <span>挂载文档</span>
                <div className="workflow-resource-options">
                  {missingRagSources.map((source) => (
                    <label key={source} className="is-missing">
                      <input
                        type="checkbox"
                        checked
                        onChange={() =>
                          updateConfig(
                            "sources",
                            ragSources.filter((item) => item !== source),
                          )
                        }
                      />
                      <span>
                        <b>{source}</b>
                        <small>文档已失效，取消勾选可移除</small>
                      </span>
                    </label>
                  ))}
                  {loading && !catalog ? (
                    <div className="node-resource-state">正在加载文档...</div>
                  ) : (catalog?.rag.sources.length ?? 0) === 0 ? (
                    <div className="node-resource-state">暂无可挂载文档</div>
                  ) : (
                    catalog?.rag.sources.map((source) => (
                      <label key={source.source}>
                        <input
                          type="checkbox"
                          checked={ragSources.includes(source.source)}
                          onChange={(event) =>
                            updateConfig(
                              "sources",
                              event.target.checked
                                ? [...ragSources, source.source]
                                : ragSources.filter((item) => item !== source.source),
                            )
                          }
                        />
                        <span>
                          <b>{source.source}</b>
                          <small>{source.chunks} 个分块</small>
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
              <label className="range-field">
                <span>
                  Top-K <b>{String(data.config.topK)}</b>
                </span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={Number(data.config.topK)}
                  onChange={(event) => updateConfig("topK", Number(event.target.value))}
                />
              </label>
            </>
          ) : null}
          {data.kind === "graph" || data.kind === "rag" ? (
            <TemplateField
              label="查询"
              value={String(data.config.query ?? "{{query}}")}
              onChange={(value) => updateConfig("query", value)}
              inputs={nodeInputs(data)}
              rows={2}
            />
          ) : null}
          {data.kind === "llm" ? (
            <>
              <label className="studio-field">
                <span>Provider</span>
                <select
                  value={String(data.config.providerId ?? "default")}
                  onChange={(event) => {
                    const provider = providers.find((item) => item.id === event.target.value);
                    updateNode({
                      config: {
                        ...data.config,
                        providerId: event.target.value,
                        model: provider?.models[0] ?? "",
                      },
                    });
                  }}
                >
                  {providers.length === 0 ? (
                    <option value="default">暂无可用 Provider</option>
                  ) : null}
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="studio-field">
                <span>模型</span>
                <select
                  value={String(data.config.model)}
                  onChange={(event) => updateConfig("model", event.target.value)}
                >
                  {[
                    ...new Set([
                      String(data.config.model),
                      ...(providers.find(
                        (provider) => provider.id === String(data.config.providerId),
                      )?.models ?? []),
                    ]),
                  ]
                    .filter(Boolean)
                    .map((model) => (
                      <option key={model}>{model}</option>
                    ))}
                </select>
              </label>
              <label className="range-field">
                <span>
                  Temperature <b>{String(data.config.temperature)}</b>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={Number(data.config.temperature)}
                  onChange={(event) => updateConfig("temperature", Number(event.target.value))}
                />
              </label>
              <TemplateField
                label="系统提示词"
                value={String(data.config.systemPrompt ?? "")}
                onChange={(value) => updateConfig("systemPrompt", value)}
                inputs={nodeInputs(data)}
                rows={5}
                hint="设定模型角色与规则。输入 {{ 或通过下方选择器插入已绑定变量。"
              />
              <TemplateField
                label="用户提示词"
                value={String(data.config.prompt ?? "")}
                onChange={(value) => updateConfig("prompt", value)}
                inputs={nodeInputs(data)}
                rows={4}
                hint="留空时自动将输入变量拼接为用户消息。"
              />
            </>
          ) : null}
          {data.kind === "mcp" ? (
            <>
              <label className="studio-field">
                <span>MCP 服务</span>
                <select
                  value={String(data.config.serviceSlug)}
                  disabled={loading}
                  onChange={(event) => {
                    updateNode({
                      config: {
                        ...data.config,
                        serviceSlug: event.target.value,
                        toolName: "",
                      },
                    });
                  }}
                >
                  <option value="">选择已授权服务</option>
                  {catalog?.mcp.services.map((service) => (
                    <option key={service.serviceSlug} value={service.serviceSlug}>
                      {service.serviceSlug}
                    </option>
                  ))}
                </select>
              </label>
              <label className="studio-field">
                <span>Tool</span>
                <select
                  value={String(data.config.toolName)}
                  disabled={!selectedService}
                  onChange={(event) => updateConfig("toolName", event.target.value)}
                >
                  <option value="">选择 Tool</option>
                  {selectedService?.tools.map((tool) => (
                    <option key={tool.name} value={tool.name}>
                      {tool.name}
                    </option>
                  ))}
                </select>
              </label>
              {selectedTool ? (
                <div className="workflow-tool-detail">
                  <p>{selectedTool.description ?? "该 Tool 未提供描述。"}</p>
                  <details>
                    <summary>Input Schema</summary>
                    <pre>{JSON.stringify(selectedTool.inputSchema, null, 2)}</pre>
                  </details>
                </div>
              ) : null}
              <TemplateField
                label="参数映射"
                json
                value={String(data.config.arguments ?? "{}")}
                onChange={(value) => updateConfig("arguments", value)}
                inputs={nodeInputs(data)}
                rows={7}
                hint={'JSON 对象；完整变量占位符保留值类型，例如 {"query": "{{query}}"}。'}
              />
            </>
          ) : null}
          {(data.kind === "rag" || data.kind === "mcp") && !loading ? (
            <button className="resource-refresh-link" type="button" onClick={refreshResources}>
              <ReloadOutlined /> 刷新资源目录
            </button>
          ) : null}
          {data.kind === "condition" ? (
            <>
              <TemplateField
                label="条件表达式"
                value={String(data.config.expression ?? "true")}
                onChange={(value) => updateConfig("expression", value)}
                inputs={nodeInputs(data)}
                rows={4}
              />
              <div className="condition-routes">
                <span>分支出口</span>
                {edges
                  .filter((edge) => edge.source === node.id)
                  .map((edge) => (
                    <label key={edge.id}>
                      <b>
                        {nodes.find((item) => item.id === edge.target)?.data.label ?? edge.target}
                      </b>
                      <select
                        value={typeof edge.label === "string" ? edge.label : ""}
                        onChange={(event) => updateEdgeLabel(edge.id, event.target.value)}
                      >
                        <option value="">默认</option>
                        <option value="true">True</option>
                        <option value="false">False</option>
                      </select>
                    </label>
                  ))}
                {edges.every((edge) => edge.source !== node.id) ? (
                  <small>连接下游节点后可配置 True / False 出口。</small>
                ) : null}
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
