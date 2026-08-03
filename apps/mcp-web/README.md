# MCP Web

[English](./README_EN.md) | [平台总览](../../README.md)

`@open-agent-tools/mcp-web` 是 MCP 管理平台的 React 管理端，通过 Control Plane API 管理服务、Tools、Prompts、Artifact、构建和版本生命周期。

## 技术栈

- React 19
- TypeScript
- Vite 5
- Lucide React
- Vitest、Testing Library、JSDOM

## 当前功能

- 浏览和刷新 MCP 服务列表。
- 创建与修改托管服务基础信息。
- 查看服务状态、当前版本和版本历史。
- 在草稿版本中新增、修改、删除 Tool。
- 在草稿版本中新增、修改、删除 Prompt。
- 使用实际 Control Plane Renderer 预览 Prompt。
- 计算 ZIP SHA-256、请求预签名 URL，并直接上传到对象存储。
- 创建 Tool 构建任务。
- 查看最近的检查/构建任务，并按状态筛选。
- 创建 MCP Client、签发或撤销一次性可见 API Key。
- 为 Client 配置 Service Grant、Scope 以及 Tool/Prompt 名称白名单。
- 查看管理端变更审计记录，并按结果或动作筛选。
- 校验 Prompt-only 版本。
- 由管理员发布、回滚、禁用或删除服务。
- 无需登录即可访问，并默认展示完整管理操作。
- 提供桌面和窄屏响应式布局。

## 目录

```text
src/
  App.tsx             管理端页面、表单和状态流
  operations.tsx      Builds、Clients/Access 和 Audit 运营视图
  api.ts              Control Plane API Client 和 DTO
  styles.css          响应式视觉样式
  main.tsx            浏览器入口
  App.test.tsx        管理流程组件测试
  api.test.ts         API Client 测试
vite.config.ts        Vite 与本地 API Proxy
```

## 运行依赖

- Node.js 20+
- 已启动的 MCP Control Plane
- Tool 上传时，S3/MinIO Presigned URL 必须允许浏览器跨域 PUT

## 本地启动

Vite 默认把 `/api` 代理到 `http://localhost:4200`：

```bash
pnpm --filter @open-agent-tools/mcp-web dev
```

访问：

```text
http://localhost:4300
```

## 访问模型

MCP Web 当前不做身份认证，任何能访问 Web 地址的人都可以进入管理平台。默认 `McpApiClient` 不读取浏览器 Token，也不会向 `/api/admin/mcp` 发送 `Authorization` Header；Control Plane 将请求作为匿名 `admin` 处理。

`App` 仍保留 `role` 属性用于组件测试和后续扩展，但生产入口固定使用默认 `admin`，不提供角色选择。

该模式只适用于本机开发或受信网络。MCP Web 和 Control Plane 不能直接暴露到公网，因为任意访问者都可以修改服务、发布 Tool、签发 MCP Client API Key 和修改 Grant。

这里的匿名访问仅适用于管理面。MCP Client 获取或调用 Tools 时仍必须通过 Gateway 提交 Bearer API Key，并受 Scope 与 `toolNames` 白名单限制。

## Tool 编辑器

Tool 表单配置：

- MCP 名称
- 描述
- JavaScript Handler 导出名
- JSON Object Input Schema

表单只允许草稿版本编辑。包含 Tools 的版本还需要上传符合规范的 Node.js ZIP 并完成构建。

## Prompt 编辑器

Prompt 表单配置：

- 名称、标题和描述
- 参数名称、描述和必填标记
- 有序 `user`/`assistant` 文本消息
- `{{argumentName}}` 占位符

预览弹窗要求填写 Prompt 参数，并调用服务端预览接口，以确保结果与 Gateway `prompts/get` 一致。

## Artifact 上传

浏览器上传过程：

1. 使用 Web Crypto 计算文件 SHA-256。
2. 请求 `/upload-url`，提交摘要和文件大小。
3. 使用响应中的 Method、Headers 和 URL 直接 PUT 到 S3/MinIO。
4. 调用 `/complete-upload`，提交 Object Key、摘要、大小和 `expectedRevision`。
5. Control Plane 创建持久化 `INSPECT` Job。

上传后版本进入 `VALIDATING`；检查/构建期间可再次上传替换包，新上传会推进 revision，旧任务自动失效。

对象存储 CORS 必须允许 Web Origin、`PUT`、签名所需 Headers 和必要的预检请求。

## API Client

`src/api.ts` 导出：

- `McpApiClient`
- `McpApiError`
- `McpAdminApi` 接口
- 服务、版本、Tool、Prompt、Build、Client、Grant 和 Audit DTO

组件测试通过注入 `McpAdminApi` Fake 隔离网络依赖。生产入口使用默认 `McpApiClient`。

## 构建与预览

```bash
pnpm --filter @open-agent-tools/mcp-web build
pnpm --filter @open-agent-tools/mcp-web preview
```

生产部署需要把 `/api` 反向代理到 Control Plane，并通过 HTTPS 提供页面和 API。

## 测试

```bash
pnpm --filter @open-agent-tools/mcp-web test
pnpm --filter @open-agent-tools/mcp-web typecheck
pnpm --filter @open-agent-tools/mcp-web lint
```

测试覆盖 API URL/Body、错误映射、角色操作、Prompt 预览、回滚和禁用入口，以及 Build 查询、Client/API Key、Tool 白名单 Grant 和 Audit 筛选。

## 当前限制

- 管理面没有身份认证或用户隔离，只适用于本机开发或受信网络。
- 暂无服务与 Client 搜索、服务类型/状态筛选和服务端分页。
- 暂无独立 Executions 页面；Build 和 Audit 页面当前各读取最近 100 条记录。
- Audit 暂无导出、归档和保留策略配置。
- Artifact 上传没有断点续传或多分片上传。
- 完整的“从已发布版本创建新草稿”操作尚未接入。
