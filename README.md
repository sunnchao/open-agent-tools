# Agent Demo MCP 管理平台

[English](./README_EN.md)

本仓库是一个 pnpm + TypeScript Monorepo。本 README 重点介绍本次新增的 MCP 管理平台：管理员可以配置、构建、发布和回滚托管 MCP 服务，MCP 客户端通过 API Key 和细粒度授权访问已发布的 Tools 与 Prompts。

仓库中的 `apps/cli`、`apps/server` 和 `apps/web` 是原有 Agent/Chat 示例，与 MCP 管理平台可以独立运行。

## 当前能力

- 管理托管 MCP 服务及其版本生命周期：草稿、校验、构建、发布、回滚、禁用和软删除。
- 配置 Tool-only、Prompt-only 或 Tools + Prompts 混合服务。
- 在草稿版本中新增、修改和删除 Tools 与 Prompts。
- 上传 Node.js Tool ZIP 包，校验归档与 npm 包结构，执行 `npm ci` 和可选构建。
- 构建、推送和摘要固定 OCI 镜像，生成 CycloneDX SBOM，并通过 Trivy 扫描镜像。
- 通过隔离 Docker 容器执行 Tool；Prompt 由 Gateway 直接校验参数并渲染。
- MCP Web 与管理 API 暂时匿名开放，任何访问者都以管理员权限操作。
- 为 MCP 客户端签发一次性可见的 API Key，按服务、Scope、Tool 名称和 Prompt 名称授权。
- 通过 Streamable HTTP 提供 `tools/list`、`tools/call`、`prompts/list` 和 `prompts/get`。
- 提供 React 管理界面，用于服务、Tool、Prompt、构建和版本操作。

当前托管运行时只支持 Node.js 20、ESM 和 npm。Python、Java、托管 MCP Resources，以及远程 MCP 代理尚未包含在当前可运行范围内。

## 系统架构

```text
Administrator
    |
    v
MCP Web (4300) ---> Control Plane (4200) ---> PostgreSQL
                          |                  -> Redis / BullMQ
                          |                  -> S3 / MinIO
                          v
                    MCP Worker ---> Docker / OCI Registry
                         |          -> Syft / Trivy
                         v
                    Tool Container

MCP Client ---> MCP Gateway (4100) ---> PostgreSQL
                      |                -> Redis / BullMQ
                      v
                  MCP Worker
```

| 组件           | 包名                                  | 职责                                                            |
| -------------- | ------------------------------------- | --------------------------------------------------------------- |
| Control Plane  | `@open-agent-tools/mcp-control-plane` | 匿名管理 API、服务版本、客户端 Key/Grant、上传和构建调度        |
| MCP Gateway    | `@open-agent-tools/mcp-server`        | MCP 协议入口、API Key 鉴权、Scope 检查、Tool 调用与 Prompt 渲染 |
| MCP Worker     | `@open-agent-tools/mcp-worker`        | ZIP 检查、依赖安装、镜像构建/扫描、Tool 容器执行                |
| MCP Web        | `@open-agent-tools/mcp-web`           | React 管理端                                                    |
| Contracts      | `@open-agent-tools/mcp-contracts`     | Manifest、Prompt、任务和 Runner I/O 的共享 Zod 契约             |
| Auth           | `@open-agent-tools/mcp-auth`          | API Key 生成、解析、哈希和校验                                  |
| Node.js Runner | `@open-agent-tools/mcp-nodejs-runner` | 在 Tool 容器内加载 handler 并校验 MCP 返回值                    |

## 目录结构

```text
apps/
  mcp-control-plane/       管理 API 与 PostgreSQL 迁移
  mcp-server/              动态 MCP Gateway
  mcp-worker/              构建和执行 Worker
  mcp-web/                 管理端 React 应用
packages/
  mcp-auth/                MCP API Key 契约
  mcp-contracts/           跨服务共享数据契约
runtimes/
  nodejs/
    Dockerfile             摘要固定、非 root Runner 镜像
    runner/                Node.js Runner 源码
    fixtures/              Tool 包与调用样例
docs/superpowers/
  specs/                   设计方案
  plans/                   测试方案
```

## 组件文档

| 组件            | 中文文档                                     | English                                            |
| --------------- | -------------------------------------------- | -------------------------------------------------- |
| Control Plane   | [README](./apps/mcp-control-plane/README.md) | [README_EN](./apps/mcp-control-plane/README_EN.md) |
| MCP Gateway     | [README](./apps/mcp-server/README.md)        | [README_EN](./apps/mcp-server/README_EN.md)        |
| MCP Worker      | [README](./apps/mcp-worker/README.md)        | [README_EN](./apps/mcp-worker/README_EN.md)        |
| MCP Web         | [README](./apps/mcp-web/README.md)           | [README_EN](./apps/mcp-web/README_EN.md)           |
| MCP Auth        | [README](./packages/mcp-auth/README.md)      | [README_EN](./packages/mcp-auth/README_EN.md)      |
| MCP Contracts   | [README](./packages/mcp-contracts/README.md) | [README_EN](./packages/mcp-contracts/README_EN.md) |
| Node.js Runtime | [README](./runtimes/nodejs/README.md)        | [README_EN](./runtimes/nodejs/README_EN.md)        |

## 环境要求

- Node.js 20 或更高版本；托管 Tool 的运行时版本固定为 Node.js 20。
- pnpm 10.32.1。
- PostgreSQL 16，Control Plane 与 Gateway 必须连接同一数据库。
- Redis 7 或兼容服务。
- S3 兼容对象存储，例如 AWS S3 或 MinIO，并预先创建 Artifact Bucket。
- Docker Engine、Docker Buildx，以及 Worker 可访问的 Docker daemon。
- OCI Registry，并提前完成 Worker 所在环境的登录。
- Worker 主机安装 `syft` 和 `trivy`。

仓库目前未提供 Docker Compose。PostgreSQL、Redis、对象存储和 Registry 需要单独准备。

## 安装

```bash
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
```

构建所有工作区包：

```bash
pnpm build
```

## 配置

### Control Plane

```bash
cp apps/mcp-control-plane/.env.example apps/mcp-control-plane/.env
```

关键变量：

| 变量                                          | 说明                            |
| --------------------------------------------- | ------------------------------- |
| `DATABASE_URL`                                | MCP 管理数据库连接串            |
| `REDIS_URL`                                   | 构建/检查 BullMQ 使用的 Redis   |
| `ARTIFACT_S3_BUCKET`                          | Tool ZIP 与 SBOM 所在 Bucket    |
| `ARTIFACT_S3_ENDPOINT`                        | MinIO 等 S3 兼容服务地址，可选  |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 凭据                         |
| `PORT`                                        | Control Plane 端口，默认 `4200` |

### MCP Gateway

```bash
cp apps/mcp-server/.env.example apps/mcp-server/.env
```

将 `DATABASE_URL` 修改为与 Control Plane 完全相同的 MCP 管理数据库。Gateway 需要以下变量：

| 变量            | 说明                                                      |
| --------------- | --------------------------------------------------------- |
| `DATABASE_URL`  | 已发布服务、API Key 和 Grant 所在数据库                   |
| `REDIS_URL`     | Tool 执行队列；未配置时只能使用不需要执行器的 Prompt 路径 |
| `MCP_HTTP_PORT` | Gateway 端口，默认 `4100`                                 |

### MCP Worker

复制示例并填写真实值：

```bash
cp apps/mcp-worker/.env.example apps/mcp-worker/.env
```

Worker 当前直接读取进程环境，不会自行加载 `.env`。在 Bash/Zsh 中可以这样启动：

```bash
set -a
source apps/mcp-worker/.env
set +a
pnpm --filter @open-agent-tools/mcp-worker dev
```

除 PostgreSQL、Redis 和 S3 变量外，Worker 还需要：

| 变量                    | 说明                                          |
| ----------------------- | --------------------------------------------- |
| `TOOL_IMAGE_REPOSITORY` | Tool 镜像 Registry Repository，不包含摘要     |
| `MCP_RUNNER_IMAGE`      | Runner 镜像，必须使用 `image@sha256:...` 格式 |
| `NPM_NETWORK`           | 构建容器安装依赖时使用的受控 Docker Network   |
| `EXECUTION_CONCURRENCY` | Tool 执行并发，默认 `4`                       |
| `BUILD_CONCURRENCY`     | 检查/构建并发，默认 `2`                       |

### MCP Web

开发服务器会把 `/api` 代理到 `http://localhost:4200`：

```bash
pnpm --filter @open-agent-tools/mcp-web dev
```

MCP Web 当前不做鉴权，不读取浏览器 Token；Control Plane 也将所有管理请求作为匿名 `admin` 处理。该模式只适用于本机开发或受信网络，不能直接暴露到公网。

## 数据库迁移

先设置与 Control Plane 相同的 `DATABASE_URL`，再运行：

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_management
pnpm --filter @open-agent-tools/mcp-control-plane db:migrate
```

迁移文件位于 `apps/mcp-control-plane/drizzle/`。不要让 Control Plane 和 Gateway 使用不同数据库，否则 Gateway 无法读取已发布服务和客户端授权。

## 构建 Node.js Runner 镜像

```bash
docker build \
  -f runtimes/nodejs/Dockerfile \
  -t registry.example.com/mcp-nodejs-runner:local \
  .

docker push registry.example.com/mcp-nodejs-runner:local
docker inspect --format='{{index .RepoDigests 0}}' registry.example.com/mcp-nodejs-runner:local
```

将最后得到的 `repository@sha256:...` 写入 `MCP_RUNNER_IMAGE`。生产环境不应使用可变 Tag。

## 本地启动

准备好依赖服务、环境变量、数据库迁移和 Runner 镜像后，分别启动：

```bash
pnpm --filter @open-agent-tools/mcp-control-plane dev
pnpm --filter @open-agent-tools/mcp-server dev
pnpm --filter @open-agent-tools/mcp-web dev
```

Worker 按前面的环境加载方式单独启动。默认地址：

| 服务                 | 地址                                               |
| -------------------- | -------------------------------------------------- |
| MCP Web              | `http://localhost:4300`                            |
| Control Plane Health | `http://localhost:4200/health`                     |
| MCP Gateway Health   | `http://localhost:4100/health`                     |
| MCP Service Endpoint | `http://localhost:4100/mcp/services/{serviceSlug}` |

不建议直接执行根目录 `pnpm dev` 来启动 MCP 平台，因为该命令还会并行启动仓库中的其他示例应用。

## 典型业务流程

1. 管理员创建 `MANAGED_MCP` 服务，系统同时创建 v1 草稿。
2. 在草稿中配置 Tools、Prompts，或上传 ZIP 并从 `mcp.json` 导入初始配置。
3. Prompt-only 版本直接校验；包含 Tools 的版本先检查 Artifact，再安装依赖和构建镜像。
4. 管理员发布 `READY` 版本，服务变为 `ACTIVE`。
5. 管理员创建 MCP Client、签发 API Key，并为服务配置 Grant 与 Scope。
6. MCP Client 使用 Bearer API Key 连接 Gateway，列出或调用获准的 Tools/Prompts。
7. 管理员可回滚到历史版本，或禁用服务以立即拒绝新的 MCP 请求。

发布版本不可修改。修改 Tool 或 Prompt 应基于新草稿生成下一版本；当前管理 API 对完整“从已发布版本自动分叉草稿”的支持仍在完善。

## Node.js Tool 包规范

上传格式必须是 ZIP，Tool 包至少包含：

```text
tool-package.zip
  mcp.json
  package.json          必须包含 "type": "module"
  package-lock.json     必需
  src/ 或 dist/
    index.js
```

最小 `mcp.json`：

```json
{
  "schemaVersion": 1,
  "runtime": { "name": "nodejs", "version": "20" },
  "entry": "src/index.js",
  "tools": [
    {
      "name": "echo",
      "description": "Echo one value",
      "handler": "echoHandler",
      "inputSchema": {
        "type": "object",
        "properties": { "value": { "type": "string" } },
        "required": ["value"],
        "additionalProperties": false
      }
    }
  ],
  "prompts": [
    {
      "name": "summarize",
      "arguments": [{ "name": "text", "required": true }],
      "messages": [
        {
          "role": "user",
          "content": { "type": "text", "text": "Summarize {{text}}." }
        }
      ]
    }
  ],
  "limits": {
    "timeoutMs": 30000,
    "memoryMb": 256,
    "cpuMillis": 1000,
    "network": "none"
  }
}
```

入口模块导出 `handlers`：

```js
export const handlers = {
  async echoHandler(args, context) {
    return {
      content: [{ type: "text", text: args.value }],
      structuredContent: { requestId: context.requestId },
    };
  },
};
```

Prompt-only 服务不需要 ZIP、Node.js Runtime、依赖安装或执行镜像。Prompt 模板只支持已声明参数的 `{{name}}` 文本插值，不执行表达式、Helper、循环、条件或任意代码。

## 客户端鉴权

管理 API 为客户端签发的原始 API Key 只返回一次，数据库仅保存哈希。Grant 支持以下 Scope：

- `mcp:connect`
- `tools:list`
- `tools:call`
- `prompts:list`
- `prompts:get`

Grant 还可以使用 `toolNames` 和 `promptNames` 限制可见能力。

例如一个服务发布了 `A`、`B`、`C` 三个 Tools：

| MCP Client Token | Grant Scope                               | `toolNames` | 可列出、可调用 |
| ---------------- | ----------------------------------------- | ----------- | -------------- |
| token1           | `mcp:connect`、`tools:list`、`tools:call` | `A`、`B`    | 仅 A、B        |
| token2           | `mcp:connect`、`tools:list`、`tools:call` | `C`         | 仅 C           |

`tools/list` 和 `tools/call` 使用同一份名称白名单。未授权 Tool 不会出现在列表中，直接调用时按“未找到”处理，也不会创建 Worker 执行任务。

MCP 客户端请求格式：

```http
POST /mcp/services/{serviceSlug} HTTP/1.1
Host: localhost:4100
Authorization: Bearer <raw-api-key>
Content-Type: application/json
```

Gateway 使用无状态 Streamable HTTP；`GET` 和 `DELETE` 会返回 `405 Method Not Allowed`。

## 管理 API 概览

所有管理接口都位于 `/api/admin/mcp`，主要包括：

- `/services`：服务 CRUD、禁用和版本列表。
- `/services/:serviceId/versions/:versionId/tools`：Tool CRUD。
- `/services/:serviceId/versions/:versionId/prompts`：Prompt CRUD 与预览。
- `/services/:serviceId/versions/:versionId/upload-url`：S3 直传地址。
- `/services/:serviceId/versions/:versionId/complete-upload`：确认上传并创建检查任务。
- `/services/:serviceId/versions/:versionId/build`：创建构建任务。
- `/services/:serviceId/versions/:versionId/validate`：校验 Prompt-only 或已构建版本。
- `/services/:serviceId/versions/:versionId/publish`：发布版本。
- `/services/:serviceId/versions/:versionId/rollback`：回滚版本。
- `/clients`、`/clients/:id/keys`、`/clients/:id/grants`：客户端、Key 和 Grant 管理。

写操作使用 `expectedRevision` 做乐观并发控制。

## 开发与测试

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
```

只运行 MCP 平台测试：

```bash
pnpm --filter @open-agent-tools/mcp-contracts test
pnpm --filter @open-agent-tools/mcp-auth test
pnpm --filter @open-agent-tools/mcp-control-plane test
pnpm --filter @open-agent-tools/mcp-server test
pnpm --filter @open-agent-tools/mcp-worker test
pnpm --filter @open-agent-tools/mcp-web test
pnpm --filter @open-agent-tools/mcp-nodejs-runner test
```

PostgreSQL 集成测试只会在设置 `TEST_DATABASE_URL` 时运行。测试会删除并重建目标数据库的 `public` Schema，因此必须使用专用测试数据库：

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_test \
  pnpm --filter @open-agent-tools/mcp-control-plane test
```

Docker E2E 还需要本机 Docker daemon 和已构建的测试 Runner 镜像。

## 安全说明

- 上传代码只在隔离的构建/执行环境中处理，不应被 Web、Control Plane 或 Gateway 直接导入。
- Tool 容器使用非 root 用户、只读根文件系统、资源限制、Capability Drop 和无网络执行策略。
- Worker 是高权限基础设施组件，应部署在隔离网络中，不应暴露到公网。
- Runner 与 Tool 镜像必须通过 SHA-256 摘要引用。
- API Key、S3/Registry 凭据、完整 Tool 输入输出和渲染后的 Prompt 不应写入普通日志。
- 生产环境需要为 PostgreSQL、Redis、S3 和 Registry 配置 TLS、备份、密钥轮换、限流和审计策略。
- 当前匿名管理面只能放在本机或受信网络；接入公网前必须恢复身份认证和授权。

## 当前限制

- 仅支持托管 Node.js 20 ESM/npm Tool；不支持 Python、Java、Yarn、pnpm Tool 包、Bun 或自定义 Dockerfile。
- 不支持托管 MCP Resources，也未完成远程 MCP 服务代理。
- 管理端已提供 Builds、Clients/Access 和 Audit 操作视图；独立 Executions 页面仍需补全。
- MCP Web 与 Control Plane 当前没有身份认证或用户隔离，不适合直接暴露到公网。
- 仓库未提供一键式 Docker Compose 或 Kubernetes 部署清单。
- Node.js 20 已结束上游生命周期；生产上线前应完成安全例外审批或升级到受支持的 LTS，并同步更新运行时契约。

## 设计与测试文档

- [MCP 管理平台 Node.js 设计方案](./docs/superpowers/specs/2026-07-31-mcp-management-platform-nodejs-design.md)
- [MCP 管理平台测试方案](./docs/superpowers/plans/2026-07-31-mcp-management-platform-nodejs-test-plan.md)
