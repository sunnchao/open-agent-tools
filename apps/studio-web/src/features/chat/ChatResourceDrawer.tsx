import { ApiOutlined, DatabaseOutlined, ReloadOutlined } from "@ant-design/icons";
import { Alert, Button, Checkbox, Drawer, Empty, Slider, Spin } from "antd";
import type { ChatResourceBinding, McpToolBinding } from "../../types.js";
import type { ResourceCatalog } from "../resources/api.js";

interface ChatResourceDrawerProps {
  open: boolean;
  catalog: ResourceCatalog | null;
  loading: boolean;
  error: string | null;
  resources: ChatResourceBinding;
  onClose: () => void;
  onRefresh: () => void;
  onChange: (resources: ChatResourceBinding) => void;
}

function sameTool(left: McpToolBinding, right: McpToolBinding): boolean {
  return left.serviceSlug === right.serviceSlug && left.toolName === right.toolName;
}

export function ChatResourceDrawer({
  open,
  catalog,
  loading,
  error,
  resources,
  onClose,
  onRefresh,
  onChange,
}: ChatResourceDrawerProps) {
  const availableSources = new Set(catalog?.rag.sources.map((item) => item.source) ?? []);
  const missingSources = resources.rag.sources.filter((source) => !availableSources.has(source));
  const availableTools = new Set(
    catalog?.mcp.services.flatMap((service) =>
      service.tools.map((tool) => `${service.serviceSlug}:${tool.name}`),
    ) ?? [],
  );
  const missingTools = resources.mcpTools.filter(
    (tool) => !availableTools.has(`${tool.serviceSlug}:${tool.toolName}`),
  );
  const toggleSource = (source: string, checked: boolean) => {
    const sources = checked
      ? [...resources.rag.sources, source]
      : resources.rag.sources.filter((item) => item !== source);
    onChange({ ...resources, rag: { ...resources.rag, sources } });
  };

  const toggleTool = (binding: McpToolBinding, checked: boolean) => {
    const mcpTools = checked
      ? [...resources.mcpTools, binding]
      : resources.mcpTools.filter((item) => !sameTool(item, binding));
    onChange({ ...resources, mcpTools });
  };

  return (
    <Drawer
      className="chat-resource-drawer"
      title="对话资源"
      open={open}
      onClose={onClose}
      size="min(420px, 100vw)"
      extra={
        <Button
          type="text"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={onRefresh}
          title="刷新资源目录"
          aria-label="刷新资源目录"
        />
      }
    >
      <p className="resource-drawer-intro">配置仅对当前会话生效，凭据由 Agent Server 管理。</p>
      {error ? <Alert type="error" showIcon title={error} /> : null}
      {loading && !catalog ? (
        <div className="resource-drawer-loading">
          <Spin />
        </div>
      ) : (
        <>
          <section className="chat-resource-section">
            <header>
              <span className="resource-section-icon rag">
                <DatabaseOutlined />
              </span>
              <div>
                <b>RAG 文档</b>
                <small>回答前检索已挂载文档</small>
              </div>
              <strong>{resources.rag.sources.length}</strong>
            </header>
            {catalog?.rag.error ? (
              <Alert type="warning" showIcon title={catalog.rag.error} />
            ) : null}
            <div className="resource-check-list">
              {missingSources.map((source) => (
                <label key={source} className="resource-check-row is-missing">
                  <Checkbox checked onChange={() => toggleSource(source, false)} />
                  <span>
                    <b>{source}</b>
                    <small>文档已失效，取消勾选可移除挂载</small>
                  </span>
                </label>
              ))}
              {(catalog?.rag.sources.length ?? 0) === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可挂载文档" />
              ) : (
                catalog?.rag.sources.map((item) => (
                  <label key={item.source} className="resource-check-row">
                    <Checkbox
                      checked={resources.rag.sources.includes(item.source)}
                      onChange={(event) => toggleSource(item.source, event.target.checked)}
                    />
                    <span>
                      <b>{item.source}</b>
                      <small>{item.chunks} 个分块</small>
                    </span>
                  </label>
                ))
              )}
            </div>
            <label className="resource-top-k">
              <span>
                Top-K <b>{resources.rag.topK}</b>
              </span>
              <Slider
                min={1}
                max={20}
                value={resources.rag.topK}
                onChange={(topK) => onChange({ ...resources, rag: { ...resources.rag, topK } })}
              />
            </label>
          </section>

          <section className="chat-resource-section">
            <header>
              <span className="resource-section-icon mcp">
                <ApiOutlined />
              </span>
              <div>
                <b>MCP Tools</b>
                <small>允许模型按需真实调用</small>
              </div>
              <strong>{resources.mcpTools.length}</strong>
            </header>
            {!catalog?.mcp.configured ? (
              <Alert type="info" showIcon title="Agent Server 尚未配置 MCP Gateway API Key" />
            ) : null}
            {catalog?.mcp.error ? (
              <Alert type="warning" showIcon title={catalog.mcp.error} />
            ) : null}
            <div className="resource-check-list">
              {missingTools.map((tool) => (
                <label
                  key={`${tool.serviceSlug}:${tool.toolName}`}
                  className="resource-check-row is-missing"
                >
                  <Checkbox checked onChange={() => toggleTool(tool, false)} />
                  <span>
                    <b>
                      {tool.serviceSlug} / {tool.toolName}
                    </b>
                    <small>Tool 已失效，取消勾选可移除绑定</small>
                  </span>
                </label>
              ))}
              {(catalog?.mcp.services.length ?? 0) === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已授权 Tool" />
              ) : (
                catalog?.mcp.services.map((service) => (
                  <div className="mcp-tool-group" key={service.serviceSlug}>
                    <p>{service.serviceSlug}</p>
                    {service.tools.map((tool) => {
                      const binding = { serviceSlug: service.serviceSlug, toolName: tool.name };
                      return (
                        <label key={tool.name} className="resource-check-row">
                          <Checkbox
                            checked={resources.mcpTools.some((item) => sameTool(item, binding))}
                            onChange={(event) => toggleTool(binding, event.target.checked)}
                          />
                          <span>
                            <b>{tool.name}</b>
                            <small>{tool.description ?? "无描述"}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}
    </Drawer>
  );
}
