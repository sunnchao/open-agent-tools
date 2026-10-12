import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Collapse,
  Empty,
  Flex,
  Form,
  Input,
  Segmented,
  Select,
  Slider,
  Spin,
  Typography,
} from "antd";
import { variableIssues, type VariableIssue } from "@open-agent-tools/workflow-contracts";
import { variableNodes } from "./variables.js";
import { RunVariablesEditor } from "./RunVariablesEditor.js";
import { TemplateField } from "./TemplateField.js";
import { ExecutionPolicyEditor } from "./ExecutionPolicyEditor.js";
import { HttpNodeEditor } from "./HttpNodeEditor.js";
import { SqlQueryNodeEditor } from "./SqlQueryNodeEditor.js";
import { nodeInputs } from "./model.js";
import { useEffect, useState } from "react";
import { PlayCircleOutlined, ReloadOutlined } from "../../lib/icons.js";
import type { ProviderMetadata } from "../../features/providers/api.js";
import { openMcpGatewaySettings } from "../../features/settings/mcpGateway.js";
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
    <Form component="div" layout="vertical" className="inspector-content node-inspector-content">
      <Flex className="inspector-title-row">
        <Flex className={`node-icon kind-${data.kind}`}>{iconByKind[data.kind]}</Flex>
        <Flex vertical className="inspector-title-copy">
          <Typography.Title level={4}>{data.label}</Typography.Title>
          <Typography.Paragraph>
            {palette.find((item) => item.kind === data.kind)?.group}
          </Typography.Paragraph>
        </Flex>
        <Button
          className="node-test-command"
          type="text"
          htmlType="button"
          disabled={testDisabled}
          title="单独测试当前节点"
          onClick={onTest}
        >
          <PlayCircleOutlined /> {testPending ? "测试中" : "测试运行"}
        </Button>
      </Flex>
      <Segmented
        className="workflow-panel-switcher"
        aria-label="节点检查器视图"
        block
        value={activeView}
        options={[
          { value: "config", label: "配置" },
          {
            value: "run",
            label: (
              <Flex align="center" gap={6}>
                上次运行
                {testResult ? (
                  <Badge status={testResult.status === "success" ? "success" : "error"} />
                ) : null}
              </Flex>
            ),
          },
        ]}
        onChange={setActiveView}
      />
      {activeView === "run" ? (
        <NodeTestResultPanel
          result={testResult}
          pending={testPending}
          disabled={testDisabled}
          onTest={onTest}
        />
      ) : (
        <>
          <Form.Item label="节点名称">
            <Input
              aria-label="节点名称"
              value={data.label}
              onChange={(event) => updateNode({ label: event.target.value })}
            />
          </Form.Item>
          <Form.Item label="说明">
            <Input
              aria-label="说明"
              value={data.description}
              onChange={(event) => updateNode({ description: event.target.value })}
            />
          </Form.Item>
          <Flex vertical className="inspector-section-title">
            参数
          </Flex>
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
          {data.kind === "http" ? <HttpNodeEditor data={data} updateConfig={updateConfig} /> : null}
          {data.kind === "sql" ? (
            <SqlQueryNodeEditor
              data={data}
              catalog={catalog}
              loading={loading}
              refreshResources={refreshResources}
              updateConfig={updateConfig}
            />
          ) : null}
          {variableIssues(variableNodes(nodes))
            .filter((issue) => issue.nodeId === node.id)
            .map((issue, index) => (
              <Alert
                type="error"
                showIcon
                className="node-resource-alert"
                key={`${issue.code}-${index}`}
                title={issue.message}
                description={
                  onRepairReference && issue.reference && issue.suggestions?.length
                    ? issue.suggestions.map((suggestion) => (
                        <Button
                          key={`${issue.reference}-${suggestion}`}
                          type="text"
                          htmlType="button"
                          className="variable-text-button"
                          onClick={() => onRepairReference(issue, suggestion)}
                        >
                          改为 {suggestion}
                        </Button>
                      ))
                    : undefined
                }
              />
            ))}
          {providerError && data.kind === "llm" ? (
            <Alert className="node-resource-alert" type="error" title={providerError} showIcon />
          ) : null}
          {resourceError && (data.kind === "rag" || data.kind === "mcp" || data.kind === "sql") ? (
            <Alert className="node-resource-alert" type="error" title={resourceError} showIcon />
          ) : null}
          {data.kind === "mcp" && catalog && !catalog.mcp.configured ? (
            <Alert
              className="node-resource-alert"
              type="error"
              title="尚未配置 MCP Gateway"
              description={
                <Button type="link" htmlType="button" onClick={openMcpGatewaySettings}>
                  前往设置配置
                </Button>
              }
              showIcon
            />
          ) : null}
          {data.kind === "rag" ? (
            <>
              <Form.Item label="挂载文档">
                <Flex vertical className="workflow-resource-options">
                  {missingRagSources.map((source) => (
                    <Checkbox
                      key={source}
                      className="is-missing"
                      checked
                      onChange={() =>
                        updateConfig(
                          "sources",
                          ragSources.filter((item) => item !== source),
                        )
                      }
                    >
                      <Flex vertical className="workflow-resource-copy">
                        <Typography.Text strong>{source}</Typography.Text>
                        <Typography.Text type="secondary">
                          文档已失效，取消勾选可移除
                        </Typography.Text>
                      </Flex>
                    </Checkbox>
                  ))}
                  {loading && !catalog ? (
                    <Spin className="node-resource-state" aria-label="正在加载文档" />
                  ) : (catalog?.rag.sources.length ?? 0) === 0 ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可挂载文档" />
                  ) : (
                    catalog?.rag.sources.map((source) => (
                      <Checkbox
                        key={source.source}
                        checked={ragSources.includes(source.source)}
                        onChange={(event) =>
                          updateConfig(
                            "sources",
                            event.target.checked
                              ? [...ragSources, source.source]
                              : ragSources.filter((item) => item !== source.source),
                          )
                        }
                      >
                        <Flex vertical className="workflow-resource-copy">
                          <Typography.Text strong>{source.source}</Typography.Text>
                          <Typography.Text type="secondary">{source.chunks} 个分块</Typography.Text>
                        </Flex>
                      </Checkbox>
                    ))
                  )}
                </Flex>
              </Form.Item>
              <Form.Item label={`Top-K · ${String(data.config.topK)}`}>
                <Slider
                  ariaLabelForHandle="Top-K"
                  min={1}
                  max={10}
                  value={Number(data.config.topK)}
                  onChange={(value) => updateConfig("topK", value)}
                />
              </Form.Item>
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
              <Form.Item label="Provider">
                <Select
                  aria-label="Provider"
                  value={String(data.config.providerId ?? "default")}
                  onChange={(value) => {
                    const provider = providers.find((item) => item.id === value);
                    updateNode({
                      config: {
                        ...data.config,
                        providerId: value,
                        model: provider?.models[0] ?? "",
                      },
                    });
                  }}
                  options={
                    providers.length === 0
                      ? [{ value: "default", label: "暂无可用 Provider" }]
                      : providers.map((provider) => ({ value: provider.id, label: provider.name }))
                  }
                />
              </Form.Item>
              <Form.Item label="模型">
                <Select
                  aria-label="模型"
                  value={String(data.config.model)}
                  onChange={(value) => updateConfig("model", value)}
                  options={[
                    ...new Set([
                      String(data.config.model),
                      ...(providers.find(
                        (provider) => provider.id === String(data.config.providerId),
                      )?.models ?? []),
                    ]),
                  ]
                    .filter(Boolean)
                    .map((model) => ({ value: model, label: model }))}
                />
              </Form.Item>
              <Form.Item label={`Temperature · ${String(data.config.temperature)}`}>
                <Slider
                  ariaLabelForHandle="Temperature"
                  min={0}
                  max={1}
                  step={0.1}
                  value={Number(data.config.temperature)}
                  onChange={(value) => updateConfig("temperature", value)}
                />
              </Form.Item>
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
              <Form.Item label="MCP 服务">
                <Select
                  aria-label="MCP 服务"
                  placeholder="选择已授权服务"
                  value={String(data.config.serviceSlug) || undefined}
                  disabled={loading}
                  onChange={(value) => {
                    updateNode({
                      config: {
                        ...data.config,
                        serviceSlug: value,
                        toolName: "",
                      },
                    });
                  }}
                  options={catalog?.mcp.services.map((service) => ({
                    value: service.serviceSlug,
                    label: service.serviceSlug,
                  }))}
                />
              </Form.Item>
              <Form.Item label="Tool">
                <Select
                  aria-label="Tool"
                  placeholder="选择 Tool"
                  value={String(data.config.toolName) || undefined}
                  disabled={!selectedService}
                  onChange={(value) => updateConfig("toolName", value)}
                  options={selectedService?.tools.map((tool) => ({
                    value: tool.name,
                    label: tool.name,
                  }))}
                />
              </Form.Item>
              {selectedTool ? (
                <Flex vertical className="workflow-tool-detail">
                  <Typography.Paragraph>
                    {selectedTool.description ?? "该 Tool 未提供描述。"}
                  </Typography.Paragraph>
                  <Collapse
                    ghost
                    items={[
                      {
                        key: "schema",
                        label: "Input Schema",
                        children: (
                          <Typography.Paragraph className="workflow-code-block">
                            {JSON.stringify(selectedTool.inputSchema, null, 2)}
                          </Typography.Paragraph>
                        ),
                      },
                    ]}
                  />
                </Flex>
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
            <Button
              className="resource-refresh-link"
              type="text"
              htmlType="button"
              onClick={refreshResources}
            >
              <ReloadOutlined /> 刷新资源目录
            </Button>
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
              <Flex vertical className="condition-routes">
                <Typography.Text>分支出口</Typography.Text>
                {edges
                  .filter((edge) => edge.source === node.id)
                  .map((edge) => (
                    <Flex className="condition-route" align="center" gap={8} key={edge.id}>
                      <Typography.Text strong>
                        {nodes.find((item) => item.id === edge.target)?.data.label ?? edge.target}
                      </Typography.Text>
                      <Select
                        aria-label={`${nodes.find((item) => item.id === edge.target)?.data.label ?? edge.target} 分支出口`}
                        value={typeof edge.label === "string" ? edge.label : ""}
                        onChange={(value) => updateEdgeLabel(edge.id, value)}
                        options={[
                          { value: "", label: "默认" },
                          { value: "true", label: "True" },
                          { value: "false", label: "False" },
                        ]}
                      />
                    </Flex>
                  ))}
                {edges.every((edge) => edge.source !== node.id) ? (
                  <Typography.Text>连接下游节点后可配置 True / False 出口。</Typography.Text>
                ) : null}
              </Flex>
            </>
          ) : null}
        </>
      )}
    </Form>
  );
}
