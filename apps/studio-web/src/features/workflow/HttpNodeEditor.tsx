import { Button, Checkbox, Flex, Form, Input, Select, Typography } from "antd";
import { useId } from "react";
import type { HttpNodeConfig } from "@open-agent-tools/workflow-contracts";
import { DeleteOutlined, PlusOutlined } from "../../lib/icons.js";
import { nodeInputs, type WorkflowNodeData, type NodeInputBinding } from "./model.js";
import { TemplateField } from "./TemplateField.js";
import { VariableSelect } from "./VariableSelect.js";

function CredentialField({
  label,
  value,
  onChange,
  inputs,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  inputs: NodeInputBinding[];
}) {
  const id = useId();
  return (
    <Form.Item label={label} htmlFor={id}>
      <Input.Password
        id={id}
        autoComplete="new-password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <VariableSelect
        label={`${label}插入变量`}
        placeholder="插入凭据变量…"
        options={inputs.map((input) => ({
          value: input.name,
          label: input.name,
          group: "本节点输入",
        }))}
        onChange={(name) => onChange(`{{${name}}}`)}
      />
    </Form.Item>
  );
}

export function HttpNodeEditor({
  data,
  updateConfig,
}: {
  data: WorkflowNodeData;
  updateConfig: (key: string, value: unknown) => void;
}) {
  const config = data.config as HttpNodeConfig;
  const inputs = nodeInputs(data);
  const method = config.method ?? "get";
  const body = config.body ?? { type: "none", data: "" };
  const auth = config.authorization ?? { type: "no-auth", config: {} };
  const updateAuth = (key: string, value: string) =>
    updateConfig("authorization", { ...auth, config: { ...auth.config, [key]: value } });
  const hasBody = !["get", "head"].includes(method);
  const fields = Array.isArray(body.data) ? body.data : [];
  return (
    <Flex vertical className="workflow-http-editor">
      <Flex vertical className="inspector-section-title">
        HTTP 请求
      </Flex>
      <Form.Item label="请求方法">
        <Select
          aria-label="请求方法"
          value={method}
          onChange={(value) => updateConfig("method", value)}
          options={["get", "head", "post", "put", "patch", "delete"].map((value) => ({
            value,
            label: value.toUpperCase(),
          }))}
        />
      </Form.Item>
      <TemplateField
        label="请求 URL"
        value={config.url ?? ""}
        onChange={(value) => updateConfig("url", value)}
        inputs={inputs}
        rows={2}
        hint="支持 HTTP/HTTPS 和已绑定变量，例如 {{response.data.id}}。"
      />
      <TemplateField
        label="查询参数"
        value={config.params ?? ""}
        onChange={(value) => updateConfig("params", value)}
        inputs={inputs}
        rows={2}
        hint="每行 key:value，也可用 & 分隔；值会自动编码并追加到 URL。"
      />
      <TemplateField
        label="请求头"
        value={config.headers ?? ""}
        onChange={(value) => updateConfig("headers", value)}
        inputs={inputs}
        rows={3}
        hint="每行 Name:Value；认证信息建议填写在下方认证配置。"
      />
      <Form.Item label="请求体类型">
        <Select
          aria-label="请求体类型"
          value={body.type ?? "none"}
          disabled={!hasBody}
          onChange={(type) => {
            updateConfig("body", {
              type,
              data: type === "form-data" ? [] : type === "json" ? "{}" : "",
            });
          }}
          options={[
            { value: "none", label: "无请求体" },
            { value: "json", label: "JSON" },
            { value: "form-data", label: "表单（文本）" },
            { value: "raw", label: "原始文本" },
          ]}
        />
      </Form.Item>
      {!hasBody ? (
        <Typography.Paragraph className="field-help">
          GET / HEAD 不发送请求体。
        </Typography.Paragraph>
      ) : null}
      {hasBody && ["json", "raw"].includes(body.type ?? "") ? (
        <TemplateField
          label={body.type === "json" ? "JSON 请求体" : "文本请求体"}
          value={
            typeof body.data === "string"
              ? body.data
              : JSON.stringify(
                  Object.fromEntries(fields.map((field) => [field.key, field.value])),
                  null,
                  2,
                )
          }
          onChange={(value) => updateConfig("body", { ...body, data: value })}
          inputs={inputs}
          rows={5}
          json={body.type === "json"}
          hint={
            body.type === "json"
              ? '完整占位符保留值类型，例如 {"count":"{{count}}"}。'
              : "支持 {{变量}} 和深度路径。"
          }
        />
      ) : null}
      {hasBody && body.type === "form-data" ? (
        <Flex vertical className="variable-bindings">
          <Flex className="variable-group-head">
            <Typography.Text>表单字段</Typography.Text>
            <Button
              type="text"
              htmlType="button"
              onClick={() =>
                updateConfig("body", {
                  ...body,
                  data: [...fields, { key: "", type: "text", value: "" }],
                })
              }
            >
              <PlusOutlined /> 添加字段
            </Button>
          </Flex>
          {fields.map((field, index) => (
            <Flex vertical className="variable-card" key={index}>
              <Flex className="variable-card-heading">
                <Input
                  aria-label="表单字段名"
                  value={field.key}
                  onChange={(event) =>
                    updateConfig("body", {
                      ...body,
                      data: fields.map((item, i) =>
                        i === index ? { ...item, key: event.target.value } : item,
                      ),
                    })
                  }
                />
                <Button
                  type="text"
                  htmlType="button"
                  aria-label="删除表单字段"
                  onClick={() =>
                    updateConfig("body", { ...body, data: fields.filter((_, i) => i !== index) })
                  }
                >
                  <DeleteOutlined />
                </Button>
              </Flex>
              <TemplateField
                label={`表单值 ${index + 1}`}
                value={field.value}
                inputs={inputs}
                rows={2}
                onChange={(value) =>
                  updateConfig("body", {
                    ...body,
                    data: fields.map((item, i) => (i === index ? { ...item, value } : item)),
                  })
                }
              />
            </Flex>
          ))}
        </Flex>
      ) : null}
      <Flex vertical className="inspector-section-title">
        认证
      </Flex>
      <Form.Item label="认证方式">
        <Select
          aria-label="认证方式"
          value={auth.type ?? "no-auth"}
          onChange={(value) =>
            updateConfig("authorization", {
              type: value,
              config: value === "custom" ? { header: "X-API-Key" } : {},
            })
          }
          options={[
            { value: "no-auth", label: "无认证" },
            { value: "basic", label: "Basic" },
            { value: "bearer", label: "Bearer" },
            { value: "custom", label: "自定义请求头" },
          ]}
        />
      </Form.Item>
      {auth.type === "basic" ? (
        <>
          <TemplateField
            label="Basic 用户名"
            value={auth.config?.username ?? ""}
            onChange={(value) => updateAuth("username", value)}
            inputs={inputs}
            rows={1}
          />
          <CredentialField
            label="Basic 密码"
            value={auth.config?.password ?? ""}
            onChange={(value) => updateAuth("password", value)}
            inputs={inputs}
          />
        </>
      ) : null}
      {auth.type === "bearer" ? (
        <CredentialField
          label="Bearer Token"
          value={auth.config?.token ?? ""}
          onChange={(value) => updateAuth("token", value)}
          inputs={inputs}
        />
      ) : null}
      {auth.type === "custom" ? (
        <>
          <TemplateField
            label="认证头名称"
            value={auth.config?.header ?? ""}
            onChange={(value) => updateAuth("header", value)}
            inputs={inputs}
            rows={1}
          />
          <CredentialField
            label="认证头值"
            value={auth.config?.value ?? ""}
            onChange={(value) => updateAuth("value", value)}
            inputs={inputs}
          />
        </>
      ) : null}
      <Typography.Paragraph className="field-help">
        凭据在运行日志中脱敏；导出和剪贴板复制会移除固定凭据，导入后请重新配置。
      </Typography.Paragraph>
      <Checkbox
        className="variable-required"
        checked={config.sslVerify !== false}
        onChange={(event) => updateConfig("sslVerify", event.target.checked)}
      >
        验证 TLS 证书
      </Checkbox>
      <Typography.Paragraph className="field-help">
        证书验证仅对当前节点的 HTTPS 请求生效。
      </Typography.Paragraph>
    </Flex>
  );
}
