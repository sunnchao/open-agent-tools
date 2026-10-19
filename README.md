# open-agent-tools 企业内部 AI 工具平台

[English](./README_EN.md)

open-agent-tools 是一个服务于企业内部的 AI 工具项目：把企业在内部落地 AI 时最常用的能力——智能对话、RAG 知识库、知识图谱、多源问数、工作流编排，以及 MCP 工具托管与治理——收敛到同一套 pnpm + TypeScript Monorepo 中，让企业内部的数据、知识和流程可以直接被 AI 调用。

`apps/studio-web` 是企业内部使用这些能力的统一可视化入口，整合 Agent Chat、RAG 知识库、知识图谱、多源问数、工作流编排和 MCP 管理；对话、工作流、问数和设置等接口由 `apps/server`（Agent Server，默认端口 `3000`）提供。`apps/cli` 与 `apps/server` 也可作为独立的 Agent/Chat 入口运行。

企业无需在多个孤立的 AI 工具之间来回切换：数据源接进来、知识库建起来、流程编排好、工具托管与授权管起来，再通过对话、IM 机器人和开放 API 交付给内部员工与业务系统。其中 MCP 管理平台（Control Plane + Gateway + Worker）是这套体系里的工具治理层，负责托管 MCP 服务的配置、构建、发布、回滚与访问授权，详细能力见下文「MCP 工具托管与治理」。

## 当前能力

### AI 工作台与应用（Studio Web 与 Agent Server）

- IM 协同入口：Studio Web「设置 → IM 渠道」可视化配置飞书/钉钉机器人（多渠道、密钥加密存储、知识库绑定），群聊 @机器人即可走 Agent Chat + RAG 知识库问答。
- 多源问数：Studio Web「设置 → Schema 数据源」管理多个 MySQL / PostgreSQL 只读连接、采集范围和默认路由；问数页按源隔离 catalog、关系图和 SQL 执行，并为每次问数记录从解析数据源到输出结果的分阶段审计，可在问数页「审计日志」检索回放。
- RAG 资产运营：支持固定切分与基于 Embedding 相似度的语义切分；文档标题/标签、内容指纹、切分参数、版本与更新时间可治理；同名重传原子替换，内置查询量、空召回率、延迟、热门来源和用户反馈看板。
- MCP Gateway 连接：Studio Web「设置 → MCP Gateway」配置工作流和对话使用的 Gateway 地址与 API Key（加密存储），保存后立即生效；未保存配置时回退到环境变量。
- 工作流编排：节点库包含开始、用户输入、知识检索、图谱检索、SQL 问数、LLM、MCP Tool、HTTP 请求、条件分支和结束节点。编辑器提供运行历史与检查点续跑、失效引用修复、运行连线高亮、节点执行策略、JSON 导入导出、多选编辑、自动布局和子图剪贴板复制粘贴。草稿可发布为不可变版本，并通过工作流级 API Key（带每分钟限流）、OpenAPI 3.1 和 `/v1/workflows/{slug}/run` 对外调用。
- 工作流 HTTP 请求节点：支持六种方法，请求体可选 JSON、纯文本或 multipart 表单（仅文本字段），支持 Basic/Bearer/自定义头认证、节点超时与重试；多结束节点按执行顺序合并最终输出，并保留逐节点调试轨迹。认证观测脱敏，导出与剪贴板复制移除固定凭据。
- 工作流 SQL 问数节点：选择 Schema 数据源（缺省使用默认源），用自然语言描述问题并可引用输入变量；复用问数模块的文本转 SQL、只读校验和审计。「默认返回条数」（1–100，缺省 100）只在问题没有指定条数时生效；问题已写明前 N 条或查询全部时以问题为准，最多返回 100 行。默认输出 `rows`、`sql`、`rowCount` 和 `auditId`；需要补充业务口径时节点报错并附审计 ID。
- 工作流条件分支节点：可视化配置 IF / ELIF / ELSE 分支，每个分支用 AND/OR 组合多条规则，内置 14 种运算符并按变量类型过滤；在画布上为每个分支选择下一节点。运行时按顺序命中第一个满足的分支，变量缺省或类型不匹配的条件按不满足处理并给出告警，运行预览和节点测试会展示命中的分支。草稿可保存未完成的条件；运行和发布前会校验变量引用、运算符、比较值类型和每个分支的下一节点。仍兼容旧的表达式模式。

### MCP 工具托管与治理

- 管理托管 MCP 服务及其版本生命周期：草稿、校验、构建、发布、回滚、禁用/启用和软删除；软删除后 Slug 可被新服务复用。
- 配置 Tool-only、Prompt-only 或 Tools + Prompts 混合服务。
- 在草稿版本中新增、修改和删除 Tools 与 Prompts；已发布版本可通过「创建草稿」分叉出新草稿继续修改。
- 上传 Node.js Tool ZIP 包，校验归档与 npm 包结构，执行 `npm ci` 和可选构建。
- 构建、推送和摘要固定 OCI 镜像，生成 CycloneDX SBOM，并通过 Trivy 扫描镜像。
- 通过隔离 Docker 容器执行 Tool；Prompt 由 Gateway 直接校验参数并渲染。
- 服务级运行环境变量：在「MCP → 服务 → 环境变量」为 Tool 配置 `TAVILY_API_KEY` 等变量。值只写不回显，保存后下一次调用生效，无需重新构建或发布。
- 版本运行限制：代码包检查后可在预览面板调整超时、内存、CPU 和网络模式（`none` 禁网、`bridge` 联网）；已发布版本只读。
- Studio Web 与管理 API 暂时匿名开放，任何访问者都以管理员权限操作。
- 为 MCP 客户端签发一次性可见的 API Key，按服务、Scope、Tool 名称和 Prompt 名称授权。
- 通过 Streamable HTTP 提供 `tools/list`、`tools/call`、`prompts/list` 和 `prompts/get`。
- 审计：Control Plane 的写操作和 Gateway 的每个 MCP 请求都会写入 `mcp_audit_events`，记录操作者、动作、结果、耗时，以及脱敏后的输入、输出和上下文；Studio Web「MCP → 审计」可按结果和动作筛选并查看详情。
- 提供 React 管理界面，覆盖服务、Tool、Prompt、构建、版本、客户端授权和审计。
- 自定义 Function Tools：`packages/function-tools` 聚合可独立打包上传的 MCP 工具包，目前包含 `pinyin`（汉字转拼音，离线运行）和 `web-search`（Tavily 联网搜索，需要 `bridge` 网络和 `TAVILY_API_KEY`），并提供交互式打包脚本。

当前托管运行时只支持 Node.js 20、ESM 和 npm。Python、Java、托管 MCP Resources，以及远程 MCP 代理尚未包含在当前可运行范围内。

## 系统架构

Studio Web 作为统一工作台，对上服务企业内部的员工与业务系统，对下连接 Agent Server（对话、工作流、问数）和 MCP 管理面。下图给出 MCP 工具托管、网关与隔离执行的链路，以及它与 Studio Web、RAG Server 的关系。

```text
Administrator
    |
    v
Studio Web (5173) ---> Control Plane (4200) ---> PostgreSQL
        |             -> RAG Server (4001) ---> SQLite
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

| 组件               | 包名                                   | 职责                                                                                                           |
| ------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Control Plane      | `@open-agent-tools/mcp-worker`         | 匿名管理 API、服务版本与运行环境变量、客户端 Key/Grant、审计、上传和构建调度                                   |
| MCP Gateway        | `@open-agent-tools/mcp-server`         | MCP 协议入口、API Key 鉴权、Scope 检查、Tool 调用与 Prompt 渲染、请求审计                                      |
| MCP Worker         | `@open-agent-tools/mcp-worker`         | ZIP 检查、依赖安装、镜像构建/扫描、Tool 容器执行                                                               |
| Agent Server       | `@open-agent-tools/server`             | Agent Chat、工作流草稿/发布/运行与 Service API、问数、IM 渠道，以及 Provider、Schema 数据源和 MCP Gateway 设置 |
| Studio Web         | `@open-agent-tools/studio-web`         | Agent、MCP、RAG、图谱、问数与工作流统一 React 工作台                                                           |
| RAG Server         | `@open-agent-tools/rag-server`         | 文档入库、SQLite 索引、混合检索与可选 LLM 回答                                                                 |
| Contracts          | `@open-agent-tools/mcp-contracts`      | Manifest、Prompt、任务和 Runner I/O 的共享 Zod 契约                                                            |
| Workflow Contracts | `@open-agent-tools/workflow-contracts` | 工作流图、变量引用、条件分支和 HTTP 节点的共享校验契约（Studio Web 与 Agent Server 共用）                      |
| Auth               | `@open-agent-tools/mcp-auth`           | API Key 生成、解析、哈希和校验                                                                                 |
| Node.js Runner     | `@open-agent-tools/mcp-nodejs-runner`  | 在 Tool 容器内加载 handler 并校验 MCP 返回值                                                                   |

Control Plane 与 Worker 共用 `@open-agent-tools/mcp-worker` 包，但仍是独立进程和权限边界：管理 API 通过 BullMQ 调度后台 Worker，Tool 仍在隔离容器内执行。管理 API 不需要 Docker Socket、Runner 镜像或 Registry 权限；这些能力只属于后台 Worker。Gateway（`apps/mcp-server`）仍是独立进程，与 Control Plane 使用同一个 PostgreSQL，并把每个 MCP 请求写入审计表。

Studio Web 的对话、工作流、问数和设置请求由 Agent Server 处理（开发时 Vite 把 `/api` 和 `/v1` 代理到 `3000`）。Agent Server 使用「设置 → MCP Gateway」中的地址和 API Key 作为 MCP 客户端访问 Gateway，知识库检索通过 `RAG_API_URL` 指向的 RAG Server 完成；会话、工作流和配置保存在它自己的 SQLite（默认 `apps/server/data/chat.sqlite`）。

## 目录结构

```text
apps/
  cli/                     命令行 Coding Agent（Pi Agent）
  mcp-server/              动态 MCP Gateway
  mcp-worker/              Control Plane 与后台 Worker 共用包
    src/index.ts          后台 Worker 入口
    src/control-plane/    Control Plane 源码与管理 API 入口 index.ts
    drizzle/              PostgreSQL 迁移 SQL 与 journal
  server/                  Agent Server：对话、工作流、问数、IM 渠道与设置
  studio-web/              统一 React 工作台
  rag-server/              RAG HTTP API 与 SQLite 数据
packages/
  database/                PostgreSQL / MySQL / Redis / Elasticsearch 连接封装
  function-tools/          自定义 MCP 工具包聚合目录（pinyin、web-search）与打包脚本
  mcp-auth/                MCP API Key 契约
  mcp-contracts/           跨服务共享数据契约
  observability/           审计脱敏与 Langfuse/OpenTelemetry 追踪
  query-resolver/          问数前置口径解析（日期、组织、费用、状态）
  rag/                     RAG 核心库：切分、入库、SQLite 向量索引、检索、CRAG 与知识图谱
  schema-catalog/          MySQL / PostgreSQL Schema 采集与渐进式加载
  workflow-contracts/      工作流图、变量、条件分支与 HTTP 节点共享契约
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

| 组件            | 中文文档                                            | English                                                   |
| --------------- | --------------------------------------------------- | --------------------------------------------------------- |
| CLI Agent       | [README](./apps/cli/README.md)                      | [README_EN](./apps/cli/README_EN.md)                      |
| Control Plane   | [CONTROL_PLANE](./apps/mcp-worker/CONTROL_PLANE.md) | [CONTROL_PLANE_EN](./apps/mcp-worker/CONTROL_PLANE_EN.md) |
| MCP Gateway     | [README](./apps/mcp-server/README.md)               | [README_EN](./apps/mcp-server/README_EN.md)               |
| MCP Worker      | [README](./apps/mcp-worker/README.md)               | [README_EN](./apps/mcp-worker/README_EN.md)               |
| Studio Web      | [README](./apps/studio-web/README.md)               | [README_EN](./apps/studio-web/README_EN.md)               |
| RAG Server      | [README](./apps/rag-server/README.md)               | -                                                         |
| MCP Auth        | [README](./packages/mcp-auth/README.md)             | [README_EN](./packages/mcp-auth/README_EN.md)             |
| MCP Contracts   | [README](./packages/mcp-contracts/README.md)        | [README_EN](./packages/mcp-contracts/README_EN.md)        |
| Node.js Runtime | [README](./runtimes/nodejs/README.md)               | [README_EN](./runtimes/nodejs/README_EN.md)               |
| Function Tools  | [README](./packages/function-tools/README.md)       | -                                                         |

## 环境要求

- Node.js 22.5 或更高版本（根 `package.json` 的 `engines` 要求；Agent Server、RAG Server 和 CLI 使用 `node:sqlite`）。托管 Tool 的运行时版本固定为 Node.js 20，由 Runner 镜像提供。
- pnpm 10.32.1。
- PostgreSQL 16，Control Plane 与 Gateway 必须连接同一数据库。
- Redis 7 或兼容服务。
- S3 兼容对象存储，例如 AWS S3 或 MinIO，并预先创建 Artifact Bucket。
- Docker Engine、Docker Buildx，以及 Worker 可访问的 Docker daemon。
- OCI Registry，并提前完成 Worker 所在环境的登录。
- Worker 主机安装 `syft` 和 `trivy`。

仓库没有完整的 Docker Compose。`scripts/docker-compose.yml` 只包含本地开发用的 MinIO（API `9000`、Console `9001`，默认账号 `minioadmin` / `minioadmin`，只应在本机使用），可用 `docker compose -f scripts/docker-compose.yml up -d` 启动，启动后仍需在 Console 创建 Artifact Bucket。PostgreSQL、Redis 和 Registry 需要单独准备。

仅启动管理 API 时需要 PostgreSQL、Redis 和 S3 配置，不需要 Docker、Buildx、Runner 镜像、Registry、Syft 或 Trivy；后者仅在后台 Worker 构建/执行 Tool 时需要。

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

只启动 Studio Web 和 Agent Server 的开发服务时，至少先构建共享包：`pnpm build:deps`（`mcp-auth`、`mcp-contracts`、`database`、`workflow-contracts` 和 `observability`）。

## 配置

### Control Plane 与 Worker 共用配置

统一示例位于 `apps/mcp-worker/.env.example`。仅在 `.env` 不存在时创建：

```bash
test -e apps/mcp-worker/.env || cp apps/mcp-worker/.env.example apps/mcp-worker/.env
```

旧的 `apps/mcp-control-plane` 目录已从仓库移除，管理 API 只读取 `apps/mcp-worker/.env`。如果本地还留着旧目录里的 `.env`，请手工把需要的值合并进来，核对数据库、Redis、S3 凭据和端口冲突；不要覆盖任何已有 `.env` 或密钥。生产部署仍应按进程分别注入必要变量和授予权限，不应因共用包而给管理 API Docker/Registry 权限。

### Control Plane

`dev:admin` 和 `start:admin` 通过既有 `dotenv` 从 `apps/mcp-worker/.env` 加载配置，只启动管理 API，默认端口为 `4200`。

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

使用前面的统一 `.env`。`dev` 和 `dev:worker` 通过 `--env-file=.env` 加载 `apps/mcp-worker/.env`，仅启动后台 Worker：

```bash
pnpm --filter @open-agent-tools/mcp-worker dev:worker
```

`start` 和 `start:worker` 保持原有行为，仅读取由进程管理器或 Shell 注入的环境变量，不自动加载 `.env`。

除 PostgreSQL、Redis 和 S3 变量外，Worker 还需要：

| 变量                    | 说明                                          |
| ----------------------- | --------------------------------------------- |
| `TOOL_IMAGE_REPOSITORY` | Tool 镜像 Registry Repository，不包含摘要     |
| `MCP_RUNNER_IMAGE`      | Runner 镜像，必须使用 `image@sha256:...` 格式 |
| `NPM_NETWORK`           | 构建容器安装依赖时使用的受控 Docker Network   |
| `EXECUTION_CONCURRENCY` | Tool 执行并发，默认 `4`                       |
| `BUILD_CONCURRENCY`     | 检查/构建并发，默认 `2`                       |

### Agent Server

```bash
test -e apps/server/.env || cp apps/server/.env.example apps/server/.env
```

`apps/server` 启动时读取 `apps/server/.env`（`.env.local` 可覆盖），默认监听 `3000`。模型 Provider 不再从环境变量注入，统一在 Studio Web「设置」中配置。关键变量：

| 变量                                      | 说明                                                                                                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONFIG_SECRETS_ENCRYPTION_KEY`           | 64 位十六进制（32 字节）密钥，用于加密保存模型 Provider Key、IM 凭据、Schema 数据源连接串和 MCP Gateway API Key；缺失时这些配置无法保存。可用 `openssl rand -hex 32` 生成，旧名称 `PROVIDER_KEYS_ENCRYPTION_KEY` 仍兼容 |
| `PORT`                                    | Agent Server 端口，默认 `3000`                                                                                                                                                                                          |
| `WEB_ORIGIN`                              | 允许访问的 Studio Web 来源，默认 `http://localhost:5173`                                                                                                                                                                |
| `RAG_API_URL`                             | RAG Server 地址，默认 `http://localhost:4001/api`                                                                                                                                                                       |
| `MCP_GATEWAY_URL` / `MCP_GATEWAY_API_KEY` | 仅在「设置 → MCP Gateway」没有保存配置时作为兜底                                                                                                                                                                        |
| `WORKFLOW_HTTP_ALLOWLIST`                 | 可选，逗号分隔的 hostname 白名单，限制工作流 HTTP 节点的目标（含重定向）；未配置时允许任意 HTTP/HTTPS 目标                                                                                                              |
| `SQLITE_PATH`                             | 可选，默认 `apps/server/data/chat.sqlite`                                                                                                                                                                               |

Langfuse、飞书 IM、问数 LLM 和报表数据库等其余变量见 `apps/server/.env.example`。

### Studio Web

开发服务器把 `/api` 和 `/v1` 代理到 Agent Server（`3000`），并把 MCP 管理 API、Gateway 和 RAG API 分别代理到 `4200`、`4100` 和 `4001`：

```bash
pnpm --filter @open-agent-tools/studio-web dev
```

Studio Web 当前不做鉴权，不读取浏览器 Token；Control Plane 也将所有管理请求作为匿名 `admin` 处理，Agent Server 的管理接口同样没有身份认证（公开的 `/v1/workflows/{slug}/run` 使用工作流 API Key）。该模式只适用于本机开发或受信网络，不能直接暴露到公网。

## 数据库迁移

先设置与 Control Plane 相同的 `DATABASE_URL`，再运行：

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_management
pnpm --filter @open-agent-tools/mcp-worker db:migrate
```

Schema 位于 `apps/mcp-worker/src/control-plane/db/schema.ts`，迁移文件位于 `apps/mcp-worker/drizzle/`。需要根据 Schema 变更生成新迁移时，使用 `pnpm --filter @open-agent-tools/mcp-worker db:generate`。

升级已有部署时，请先执行 `db:migrate`，再重启 Control Plane、Gateway 和 Worker。近期新增的迁移：`0004` 为服务增加运行环境变量，`0005` 允许复用已软删除服务的 Slug，`0006` 为审计事件增加来源（Control Plane 或 Gateway）、输入、输出和上下文字段。

旧 `apps/mcp-control-plane` 目录及其 `drizzle` 兼容链接已移除，迁移历史只保留在 `apps/mcp-worker/drizzle/`。不要让 Control Plane 和 Gateway 使用不同数据库，否则 Gateway 无法读取已发布服务和客户端授权。

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

准备好 PostgreSQL、Redis、S3 配置和数据库迁移后，分别启动管理 API 与其他服务；管理 API 无需准备 Docker、Runner 镜像或 Registry：

```bash
pnpm --filter @open-agent-tools/mcp-worker dev:admin
pnpm --filter @open-agent-tools/mcp-server dev
pnpm --filter @open-agent-tools/rag-server dev
pnpm --filter @open-agent-tools/server dev
pnpm --filter @open-agent-tools/studio-web dev
```

Agent Server 需要先准备 `apps/server/.env`（见上文）并执行 `pnpm build:deps`。

需要检查、构建或执行 Tool 时，再准备 Docker、Runner 镜像、Registry 等 Worker 依赖，并在另一个进程启动：

```bash
pnpm --filter @open-agent-tools/mcp-worker dev:worker
```

兼容脚本 `dev` 仍等同于 `dev:worker`，不会启动管理 API。构建后使用 `pnpm --filter @open-agent-tools/mcp-worker start:admin` 启动管理 API，使用 `start:worker`（或兼容的 `start`）启动已注入环境变量的后台 Worker；两者都不会启动另一角色。后台入口仍为 `src/index.ts` → `dist/index.js`，管理入口为 `src/control-plane/index.ts` → `dist/control-plane/index.js`。

默认地址：

| 服务                 | 地址                                               |
| -------------------- | -------------------------------------------------- |
| Studio Web           | `http://localhost:5173`                            |
| RAG Server Health    | `http://localhost:4001/api/health`                 |
| Agent Server Health  | `http://localhost:3000/health`                     |
| Control Plane Health | `http://localhost:4200/health`                     |
| MCP Gateway Health   | `http://localhost:4100/health`                     |
| MCP Service Endpoint | `http://localhost:4100/mcp/services/{serviceSlug}` |

根目录 `pnpm dev` 现在执行 `pnpm -r --parallel --if-present run "/^dev(:admin)?$/"`，因此移除旧 Control Plane 包后仍会分别启动共用包的后台 `dev` 和管理 `dev:admin` 进程，也会继续启动其他应用的 `dev`。MCP-only 工作流应使用前面的包级命令，不建议执行根目录 `pnpm dev`。

## 典型业务流程

1. 管理员创建 `MANAGED_MCP` 服务，系统同时创建 v1 草稿。
2. 在草稿中配置 Tools、Prompts，或上传 ZIP 并从 `mcp.json` 导入初始配置。
3. Prompt-only 版本直接校验；包含 Tools 的版本先检查 Artifact，再安装依赖和构建镜像。
4. 管理员发布 `READY` 版本，服务变为 `ACTIVE`。
5. 管理员创建 MCP Client、签发 API Key，并为服务配置 Grant 与 Scope。
6. MCP Client 使用 Bearer API Key 连接 Gateway，列出或调用获准的 Tools/Prompts。
7. 管理员可回滚到历史版本，或禁用服务以立即拒绝新的 MCP 请求；已禁用的服务可以重新启用。

发布版本不可修改。需要调整 Tool 或 Prompt 时，在 Studio Web 对已发布或已被取代的版本点击「创建草稿」（对应 `fork-draft` 接口）：新草稿会复制 Tools、Prompts、运行限制和 Artifact 引用，并清空镜像摘要。包含 Tools 的草稿需要重新构建后才能校验和发布，不必重新上传 ZIP。

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

`limits.network` 必须是 `none`（禁网）或 `bridge`（允许联网）。需要访问外部 API 的 Tool 应声明 `bridge`，并把密钥放在服务的「环境变量」中，而不是写进代码包或 Tool 参数；Worker 会在每次执行前读取这些变量并注入容器，更新后无需重新构建。

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

- `/services`：服务 CRUD、禁用/启用和版本列表。
- `/services/:serviceId/environment`：读取（仅变量名）和更新 Tool 运行环境变量。
- `/services/:serviceId/versions/:versionId/limits`：更新版本的超时、内存、CPU 和网络模式。
- `/services/:serviceId/versions/:versionId/tools`：Tool CRUD。
- `/services/:serviceId/versions/:versionId/prompts`：Prompt CRUD 与预览。
- `/services/:serviceId/versions/:versionId/upload-url`：S3 直传地址。
- `/services/:serviceId/versions/:versionId/complete-upload`：确认上传并创建检查任务。
- `/services/:serviceId/versions/:versionId/build`：创建构建任务。
- `/services/:serviceId/versions/:versionId/validate`：校验 Prompt-only 或已构建版本。
- `/services/:serviceId/versions/:versionId/reset-to-draft`：把未发布的 `READY` 版本退回草稿。
- `/services/:serviceId/versions/:versionId/fork-draft`：基于已发布或已被取代的版本创建新草稿。
- `/services/:serviceId/versions/:versionId/publish`：发布版本。
- `/services/:serviceId/versions/:versionId/rollback`：回滚版本。
- `/builds`：检查和构建任务列表。
- `/audit`、`/audit/:eventId`：审计事件列表与详情。
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
pnpm --filter @open-agent-tools/mcp-server test
pnpm --filter @open-agent-tools/mcp-worker test
pnpm --filter @open-agent-tools/studio-web test
pnpm --filter @open-agent-tools/mcp-nodejs-runner test
```

`mcp-worker test` 同时覆盖合并后的 Control Plane 与后台 Worker 测试，不再单独运行已删除包的测试。

PostgreSQL 集成测试只会在设置 `TEST_DATABASE_URL` 时运行。测试会删除并重建目标数据库的 `public` Schema，因此必须使用专用测试数据库：

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_test \
  pnpm --filter @open-agent-tools/mcp-worker test
```

Docker E2E 还需要本机 Docker daemon 和已构建的测试 Runner 镜像。

## 安全说明

- 上传代码只在隔离的构建/执行环境中处理，不应被 Web、Control Plane 或 Gateway 直接导入。
- Tool 容器使用非 root 用户、只读根文件系统、资源限制和 Capability Drop；按已发布版本的 `limits.network` 使用 `none` 禁网或 `bridge` 联网。
- Worker 是高权限基础设施组件，应部署在隔离网络中，不应暴露到公网。
- Runner 与 Tool 镜像必须通过 SHA-256 摘要引用。
- API Key、S3/Registry 凭据、完整 Tool 输入输出和渲染后的 Prompt 不应写入普通日志。
- 审计事件会保存脱敏后的请求和响应：敏感字段名、`mcp.*` API Key、Bearer Token、URL 凭据和服务环境变量值会被屏蔽，但 Tool 输入输出等业务内容仍可能包含敏感数据。审计表是上一条规则的受控例外，只应向维护人员开放，并需要规划保留与归档策略。
- 联网 Tool（`limits.network: "bridge"`）的密钥只放在服务环境变量中；变量值不会写入队列任务或镜像，审计内容中也会被屏蔽。
- 工作流 HTTP 请求节点在未配置 `WORKFLOW_HTTP_ALLOWLIST` 时允许访问任意 HTTP/HTTPS 目标；生产环境应配置 hostname 白名单。
- 生产环境需要为 PostgreSQL、Redis、S3 和 Registry 配置 TLS、备份、密钥轮换、限流和审计策略。
- 当前匿名管理面只能放在本机或受信网络；接入公网前必须恢复身份认证和授权。

## 当前限制

- 仅支持托管 Node.js 20 ESM/npm Tool；不支持 Python、Java、Yarn、pnpm Tool 包、Bun 或自定义 Dockerfile。
- 不支持托管 MCP Resources，也未完成远程 MCP 服务代理。
- 管理端已提供 Builds、Clients/Access 和 Audit 操作视图；独立 Executions 页面仍需补全。
- Studio Web、Control Plane 与 Agent Server 当前没有身份认证或用户隔离，不适合直接暴露到公网。
- 仓库未提供一键式 Docker Compose 或 Kubernetes 部署清单。
- Node.js 20 已结束上游生命周期；生产上线前应完成安全例外审批或升级到受支持的 LTS，并同步更新运行时契约。

## 设计与测试文档

- [MCP 管理平台 Node.js 设计方案](./docs/superpowers/specs/2026-07-31-mcp-management-platform-nodejs-design.md)
- [MCP 管理平台测试方案](./docs/superpowers/plans/2026-07-31-mcp-management-platform-nodejs-test-plan.md)

## 部署与演示

- [私有化部署总览(30 分钟安装路径)](./docs/deploy/README.md)
- [私有化部署手册(前置条件 / 端口与环境变量矩阵 / 备份 / 排障 / 安全基线)](./docs/deploy/private-deployment.md)
- [内网 / 离线安装](./docs/deploy/offline-install.md)
- [三个 SKU 的 10 分钟演示脚本](./docs/demo/README.md)
- 脚本入口:`scripts/deploy/bootstrap.sh`(一键引导)、`scripts/deploy/verify.sh`(只读健康检查)、
  `scripts/demo/seed.sh`(演示数据准备)、`scripts/deploy/docker-compose.prod.yml`(基础设施编排)、
  `scripts/deploy/systemd/`(常驻服务 unit 模板)。
