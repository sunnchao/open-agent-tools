import { Alert, Button, Form, InputNumber, Select, Typography } from "antd";
import { ReloadOutlined, SettingOutlined } from "../../lib/icons.js";
import type { ResourceCatalog } from "../resources/api.js";
import { nodeInputs, type WorkflowNodeData } from "./model.js";
import { TemplateField } from "./TemplateField.js";

export function SqlQueryNodeEditor({
  data,
  catalog,
  loading,
  refreshResources,
  updateConfig,
}: {
  data: WorkflowNodeData;
  catalog: ResourceCatalog | null;
  loading: boolean;
  refreshResources: () => void;
  updateConfig: (key: string, value: unknown) => void;
}) {
  const sources = catalog?.sql?.sources ?? [];
  const sourceId = String(data.config.sourceId ?? "");
  const missing = Boolean(
    sourceId && !loading && !sources.some((source) => source.id === sourceId),
  );
  const defaultSource = sources.find((source) => source.isDefault);
  return (
    <>
      <Form.Item label="SQL 数据源">
        <Select
          aria-label="SQL 数据源"
          loading={loading}
          value={sourceId}
          status={missing ? "error" : undefined}
          onChange={(value) => updateConfig("sourceId", value)}
          options={[
            {
              value: "",
              label: defaultSource ? `默认数据源 · ${defaultSource.name}` : "使用默认数据源",
            },
            ...(missing
              ? [{ value: sourceId, label: `已失效 · ${sourceId}`, disabled: true }]
              : []),
            ...sources.map((source) => ({
              value: source.id,
              label: `${source.name} · ${source.connector}`,
            })),
          ]}
        />
      </Form.Item>
      {catalog?.sql?.error || missing || (!loading && sources.length === 0) ? (
        <Alert
          type="warning"
          showIcon
          className="node-resource-alert"
          title={
            catalog?.sql?.error ?? (missing ? "所选数据源已停用或删除" : "尚未配置可用 SQL 数据源")
          }
        />
      ) : null}
      <TemplateField
        label="问数问题"
        value={String(data.config.query ?? "{{query}}")}
        onChange={(value) => updateConfig("query", value)}
        inputs={nodeInputs(data)}
        rows={4}
        hint="用自然语言描述要查询的数据；支持插入输入变量，例如：最近 {{days}} 天的订单金额前 10 名。"
      />
      <Form.Item label="默认返回条数">
        <InputNumber
          aria-label="默认返回条数"
          min={1}
          max={100}
          value={Number(data.config.maxRows ?? 100)}
          onChange={(value) => {
            if (value !== null) updateConfig("maxRows", value);
          }}
        />
      </Form.Item>
      <Typography.Paragraph className="field-help">
        问题未指定条数时使用此值。问题已指定前 N 条或查询全部时遵循问题口径， 最多返回 100
        行。使用问数模块配置的模型，查询经过只读校验并记录审计日志。
      </Typography.Paragraph>
      <Typography.Paragraph className="field-help">
        默认输出 rows、sql、rowCount、auditId，可连接 LLM 汇总结果或连接结束节点返回数据。
        需要补充业务口径时节点会报错，请完善问题后重新运行。
      </Typography.Paragraph>
      <div className="sql-node-resource-actions">
        <Button type="text" htmlType="button" onClick={refreshResources} disabled={loading}>
          <ReloadOutlined /> 刷新数据源
        </Button>
        <Button
          type="text"
          htmlType="button"
          onClick={() => {
            sessionStorage.setItem("open-agent-tools.settings-section", "schema-sources");
            window.location.hash = "settings";
          }}
        >
          <SettingOutlined /> 管理数据源
        </Button>
      </div>
    </>
  );
}
