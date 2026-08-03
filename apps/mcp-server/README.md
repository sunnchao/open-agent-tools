# MCP Gateway

[English](./README_EN.md) | [平台总览](../../README.md)

`@open-agent-tools/mcp-server` 是 MCP 平台的数据面入口。它从 PostgreSQL 读取已发布服务快照，校验 MCP Client API Key 与 Grant，并通过无状态 Streamable HTTP 暴露 Tools 和 Prompts。

## 请求流程

1. MCP Client 向 `/mcp/services/:serviceSlug` 发送带 Bearer API Key 的 `POST` 请求。
2. Gateway 解析 Key ID，并通过 scrypt 哈希校验密钥。
3. 校验 Key、Client、过期时间、服务状态、当前发布版本和 Grant。
4. 为本次请求创建只包含已授权能力的 `McpServer`。
5. `tools/list` 和 `prompts/list` 从同一个发布版本快照返回元数据。
6. `prompts/get` 在 Gateway 中校验参数并渲染模板。
7. `tools/call` 校验 JSON Schema 后向 BullMQ 提交摘要固定的执行任务。

Gateway 不加载 Tool 模块、不安装依赖，也不直接启动 Docker 容器。

## 支持的 MCP 能力

- `tools/list`
- `tools/call`
- `prompts/list`
- `prompts/get`

当前托管服务不支持 `resources/list` 和 `resources/read`。

## Endpoint

```text
POST   /mcp/services/:serviceSlug
GET    /health
```

MCP Endpoint 使用无状态 Streamable HTTP。对服务路径执行 `GET` 或 `DELETE` 会返回 MCP 兼容的 `405 Method Not Allowed`。

示例请求头：

```http
POST /mcp/services/reporting HTTP/1.1
Host: localhost:4100
Authorization: Bearer mcp.<key-id>.<secret>
Content-Type: application/json
```

请求 Body 由 MCP SDK 的 Streamable HTTP Client 生成。

## 鉴权与授权

认证前置条件：

- API Key 存在、为 `ACTIVE`、未过期且哈希匹配。
- 所属 Client 为 `ACTIVE`。
- 服务为 `ACTIVE`，当前版本为 `PUBLISHED`。
- Client 对服务存在 Grant，且包含 `mcp:connect`。

操作级 Scope：

| MCP 操作       | Scope          |
| -------------- | -------------- |
| `tools/list`   | `tools:list`   |
| `tools/call`   | `tools:call`   |
| `prompts/list` | `prompts:list` |
| `prompts/get`  | `prompts:get`  |

`toolNames` 和 `promptNames` 过滤器会同时影响列表与调用/获取。未授权名称按“未找到”处理，避免泄露隐藏能力。

例如服务包含 `A`、`B`、`C` 三个 Tools：

| MCP Client Token | Grant `toolNames` | `tools/list` 可见 | `tools/call` 可用 |
| ---------------- | ----------------- | ----------------- | ----------------- |
| token1           | `["A", "B"]`      | A、B              | 仅 A、B           |
| token2           | `["C"]`           | C                 | 仅 C              |

两个 Grant 都必须包含 `mcp:connect`、`tools:list` 和 `tools:call`。token1 调用 C、token2 调用 A/B 时都返回 Tool 未找到，且不会创建执行任务。

## 环境变量

```bash
cp .env.example .env.local
```

| 变量            | 必需          | 说明                                   |
| --------------- | ------------- | -------------------------------------- |
| `DATABASE_URL`  | 是            | 与 Control Plane 相同的 MCP 管理数据库 |
| `REDIS_URL`     | Tool 调用必需 | BullMQ Tool 执行队列                   |
| `MCP_HTTP_PORT` | 否            | HTTP 端口，默认 `4100`                 |

如果不设置 `REDIS_URL`，Gateway 可以提供 Prompt 路径，但包含 Tools 的服务无法完成 `tools/call`。

## 启动

```bash
pnpm --filter @open-agent-tools/mcp-server dev
```

生产构建与启动：

```bash
pnpm --filter @open-agent-tools/mcp-server build
pnpm --filter @open-agent-tools/mcp-server start
```

构建脚本会把 `src/resources` 复制到 `dist/resources`。该目录属于原有静态资源示例，不代表当前托管 MCP Resources 能力。

## 数据来源

`PostgresGatewayRepository` 从以下管理表读取数据：

- `api_keys`
- `api_clients`
- `client_grants`
- `mcp_services`
- `mcp_service_versions`
- `mcp_tools`
- `mcp_prompts`

Control Plane、Gateway 和 Worker 必须使用同一个 PostgreSQL 数据库。Gateway 只接受当前服务指向的 `PUBLISHED` 版本。

## Tool 调用

- 使用 Ajv 2020 校验 Tool 参数。
- 未通过校验时不会创建执行任务。
- 任务写入 `mcp-tool-execution` 队列。
- Job 固定 `serviceId`、`versionId`、`imageDigest`、Tool 名称、调用参数、Client ID、Deadline 和执行限制。
- BullMQ Job 不自动重试 Tool 调用，避免非幂等副作用重复发生。
- Worker 返回值再次通过共享 MCP Result 契约校验。

## Prompt 渲染

- Prompt 定义来自已发布版本。
- 需要 `prompts:get` Scope。
- 只接受已声明的字符串参数。
- 必填参数缺失和未声明参数会返回协议安全错误。
- 渲染使用 `@open-agent-tools/mcp-contracts` 中与管理端预览相同的 `renderPrompt`。
- Prompt 不进入执行队列，也不会启动 Tool 容器。

## HTTP 错误

| 场景                                 | 状态码 |
| ------------------------------------ | ------ |
| 缺失、格式错误、未知、撤销或过期 Key | `401`  |
| 缺少服务 Grant 或 `mcp:connect`      | `403`  |
| 服务不存在                           | `404`  |
| 服务未激活或没有发布版本             | `503`  |
| 不支持的方法                         | `405`  |
| 未处理内部错误                       | `500`  |

MCP 方法级错误由 SDK 以 JSON-RPC/MCP 安全错误返回，不包含内部堆栈或主机路径。

## 测试

```bash
pnpm --filter @open-agent-tools/mcp-server test
pnpm --filter @open-agent-tools/mcp-server typecheck
pnpm --filter @open-agent-tools/mcp-server lint
```

PostgreSQL E2E：

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_test \
  pnpm --filter @open-agent-tools/mcp-server test
```

该测试会删除并重建目标数据库的 `public` Schema，只能连接专用测试数据库。

## 当前限制

- 仅支持托管 MCP 服务；远程 MCP 转发尚未接入。
- 当前实例按请求创建无状态 MCP Server，不提供长生命周期 Session。
- 尚未接入分布式授权/能力缓存及主动失效通知。
- 生产限流、并发配额和完整可观测性仍需由网关基础设施补充。
