# MCP Control Plane

[English](./CONTROL_PLANE_EN.md) | [平台总览](../../README.md) | [后台 Worker](./README.md)

Control Plane 是 MCP 管理平台的控制面服务，现与后台 Worker 共用 `@open-agent-tools/mcp-worker` 包，负责管理服务、版本、Tools、Prompts、上传/构建任务以及 MCP Client 的 API Key 和 Grant。它不执行上传代码，也不直接处理 MCP 协议请求。

原 Control Plane 源码（包括入口）位于 `apps/mcp-worker/src/control-plane/`。管理 API 使用独立入口和进程，通过 BullMQ 调度后台 Worker；共用包不意味着合并进程或权限，Tool 仍在隔离容器内执行。管理 API 不需要 Docker Socket、Runner 镜像或 Registry 权限。后台 Worker 的入口仍为 `src/index.ts`，与管理入口分离。

## 主要职责

- 当前将所有 `/api/admin/mcp` 请求映射为匿名 `admin`，不要求登录或 Bearer Token。
- 管理 `MANAGED_MCP` 服务和不可变版本。
- 管理草稿 Tools、Prompts 和 Prompt 预览。
- 为浏览器签发 S3 预签名上传 URL，并确认 ZIP 的大小和 SHA-256。
- 在 PostgreSQL 中持久化检查/构建任务，再通过 BullMQ 调度 Worker。
- 管理 MCP Client、一次性可见 API Key、Scope 和名称过滤 Grant。
- 查询持久化 Build Job，并记录和查询管理端写操作审计事件。
- 通过 `revision`/`expectedRevision` 提供乐观并发控制。
- 在 PostgreSQL 事务中原子发布或回滚版本。

## 非职责范围

- 不在 Control Plane 进程中解压、安装或执行用户代码。
- 不处理 `/mcp/services/:serviceSlug` 协议请求；该路径由 MCP Gateway 提供。
- 当前 HTTP 创建接口只接受 `MANAGED_MCP`。远程 MCP 管理尚未接入运行入口。
- `apps/mcp-server` 不在本次合并范围内，其结构、职责和文档保持不变。

## 运行依赖

- PostgreSQL 16
- Redis/BullMQ
- S3 兼容对象存储
- `@open-agent-tools/mcp-auth`
- `@open-agent-tools/mcp-contracts`

仅启动管理 API 时不需要 Docker、Buildx、Runner 镜像、Registry、Syft 或 Trivy；检查、构建和执行任务由单独启动的后台 Worker 处理。

## 环境变量

统一示例位于 `apps/mcp-worker/.env.example`。在仓库根目录执行，仅在 `.env` 不存在时创建配置：

```bash
test -e apps/mcp-worker/.env || cp apps/mcp-worker/.env.example apps/mcp-worker/.env
```

`dev:admin` 和 `start:admin` 沿用既有 `dotenv`，从 `apps/mcp-worker/.env` 加载变量，不再读取旧 `apps/mcp-control-plane/.env`。若两个目录已有本地配置，请手工将原 Control Plane 所需值合并到 Worker 的 `.env`，核对数据库、Redis、S3 凭据和端口冲突；不要覆盖任何已有 `.env` 或密钥。

后台 `dev`/`dev:worker` 使用 `--env-file=.env`；后台 `start`/`start:worker` 保持原有环境注入方式，不自动加载 `.env`。生产部署应为管理 API 与后台 Worker 分别配置最小必要变量和权限，不给管理进程 Docker/Registry 权限。

| 变量                    | 必需       | 说明                                           |
| ----------------------- | ---------- | ---------------------------------------------- |
| `DATABASE_URL`          | 是         | MCP 管理数据库连接串                           |
| `REDIS_URL`             | 是         | Artifact 检查和构建队列                        |
| `ARTIFACT_S3_BUCKET`    | 是         | ZIP 和 SBOM Bucket                             |
| `ARTIFACT_S3_REGION`    | 否         | 默认 `us-east-1`                               |
| `ARTIFACT_S3_ENDPOINT`  | 否         | MinIO 等自定义 Endpoint；配置后启用 Path-style |
| `AWS_ACCESS_KEY_ID`     | 视环境而定 | S3 凭据                                        |
| `AWS_SECRET_ACCESS_KEY` | 视环境而定 | S3 凭据                                        |
| `PORT`                  | 否         | HTTP 端口，默认 `4200`                         |

## 数据库迁移

Schema 位于 `src/control-plane/db/schema.ts`（仓库路径 `apps/mcp-worker/src/control-plane/db/schema.ts`），迁移目录为 `apps/mcp-worker/drizzle/`。Drizzle 配置从进程环境读取 `DATABASE_URL`：

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_management
pnpm --filter @open-agent-tools/mcp-worker db:migrate
```

迁移文件：

- `drizzle/0000_mcp_management.sql`
- `drizzle/0001_mcp_client_access.sql`
- `drizzle/0002_mcp_build_jobs.sql`
- `drizzle/0003_mcp_audit_events.sql`
- `drizzle/0004_mcp_service_environment.sql`
- `drizzle/meta/_journal.json`

原有迁移 SQL 保持不变，journal 追加新的迁移条目。需要根据 Schema 变更生成新迁移时，使用 `pnpm --filter @open-agent-tools/mcp-worker db:generate`。

### Tool 运行环境变量

`GET /api/admin/mcp/services/:serviceId/environment` 返回 `{ environment, revision }`，其中 `environment` 仅包含变量名和 `null` 占位，不返回已保存的值。`PUT` 接收 `{ expectedRevision, environment }`：字符串设置或替换值，`null` 保留同名已保存值，省略的变量会删除。只有 admin/operator 可读写，写入使用服务 revision 检查冲突。

变量保存在 `mcp_services.environment`，独立于版本、Manifest 和上传包。Worker 在每次执行前读取服务配置并注入容器，更新后无需重新构建。环境变量不会加入 BullMQ 任务或审计请求正文；执行容器网络由已发布版本的 `limits.network` 决定。

`PUT /api/admin/mcp/services/:serviceId/versions/:versionId/limits` 接收 `{ expectedRevision, limits }`，更新完整的超时、内存、CPU 和 `none`/`bridge` 网络配置。允许 admin/operator 修改 DRAFT、FAILED 和未发布的 READY 版本；已发布版本不可变，处理中的版本不可修改。限制保存不改变工具代码或已构建镜像，构建完成会保留面板修改后的值。

旧 `apps/mcp-control-plane` 不再是工作区包或源码树，只保留 README 跳转和 `drizzle -> ../mcp-worker/drizzle` 符号链接，以兼容旧迁移路径消费者；不需要修改 `apps/mcp-server`。Control Plane、Gateway 和后台 Worker 必须连接同一套迁移后的数据库。

## 启动

在仓库根目录执行，只启动管理 API，不启动后台 Worker：

```bash
pnpm --filter @open-agent-tools/mcp-worker dev:admin
```

管理入口为 `src/control-plane/index.ts`，无需 Docker、Runner 镜像或 Registry。

生产构建与启动：

```bash
pnpm --filter @open-agent-tools/mcp-worker build
pnpm --filter @open-agent-tools/mcp-worker start:admin
```

`start:admin` 只运行 `dist/control-plane/index.js`，默认端口为 `4200`。兼容脚本 `dev`/`start` 仍只启动后台 Worker，`dev:worker`/`start:worker` 是显式别名。完整 Tool 流程需要另一个后台 Worker 进程，启动方式见 [Worker 文档](./README.md#启动)。

健康检查：

```text
GET http://localhost:4200/health
```

## 当前访问模型与内部角色

默认启动入口不配置认证器。任何访问者都可以调用 `/api/admin/mcp`，请求统一使用 `{ id: "anonymous", role: "admin" }` 执行，因此 MCP Web 不需要登录，也不会发送管理端 Token。

这是临时开发策略，不是生产安全边界。匿名管理面可以创建 Client、签发 API Key、修改 Grant、发布代码和禁用服务，只能部署在本机或受信网络；不要直接暴露到公网。

Control Plane 内部仍保留以下角色权限模型，供测试和后续重新接入认证器使用：

| 能力                            | admin | operator | auditor |
| ------------------------------- | ----- | -------- | ------- |
| 读取服务和版本                  | 是    | 是       | 是      |
| 创建/编辑服务、Tool、Prompt     | 是    | 是       | 否      |
| 上传、校验、创建构建任务        | 是    | 是       | 否      |
| 发布、回滚、禁用、删除服务      | 是    | 否       | 否      |
| 创建/撤销 Client Key 和 Grant   | 是    | 否       | 否      |
| 读取 Client、Key 元数据和 Grant | 是    | 否       | 是      |
| 读取管理操作审计事件            | 是    | 否       | 是      |

原始 API Key 只在创建响应中出现一次；读取 Key 列表不会返回哈希或原始值。

默认匿名模式始终使用 `admin` 权限，MCP Web 当前不提供角色选择。

## 服务和版本状态

服务状态：

```text
DRAFT -> ACTIVE -> DISABLED -> DELETED
```

托管版本状态：

```text
DRAFT -> VALIDATING -> BUILDING -> READY -> PUBLISHED -> SUPERSEDED
                    \-> FAILED
```

- Prompt-only 草稿可由 `DRAFT -> READY` 完成校验，不创建镜像。
- 包含 Tools 的版本必须先获得构建后的 `imageDigest` 才能进入 `READY`。
- `DRAFT`、`FAILED`、`VALIDATING`、`BUILDING` 状态的版本可接受上传；重新上传会推进 revision，使旧检查/构建任务失效。
- 只有 `READY` 版本可发布。
- 发布版本不可编辑。
- 回滚只切换已有 `READY` 或 `SUPERSEDED` 版本，不重新构建。

## API 分组

所有管理 API 都以 `/api/admin/mcp` 开头。

### 服务

```text
GET    /services
POST   /services
GET    /services/:serviceId
PATCH  /services/:serviceId
DELETE /services/:serviceId
POST   /services/:serviceId/disable
GET    /services/:serviceId/versions
```

### Tools 与 Prompts

```text
GET|POST          /services/:serviceId/versions/:versionId/tools
PATCH|DELETE      /services/:serviceId/versions/:versionId/tools/:toolId
GET|POST          /services/:serviceId/versions/:versionId/prompts
PATCH|DELETE      /services/:serviceId/versions/:versionId/prompts/:promptId
POST              /services/:serviceId/versions/:versionId/prompts/:promptId/preview
```

### 上传、构建和发布

```text
POST /services/:serviceId/versions/:versionId/upload-url
POST /services/:serviceId/versions/:versionId/complete-upload
POST /services/:serviceId/versions/:versionId/build
POST /services/:serviceId/versions/:versionId/validate
POST /services/:serviceId/versions/:versionId/publish
POST /services/:serviceId/versions/:versionId/rollback
```

### Client 访问

```text
GET|POST     /clients
GET|POST     /clients/:clientId/keys
DELETE       /clients/:clientId/keys/:keyId
GET          /clients/:clientId/grants
PUT|DELETE   /clients/:clientId/grants/:serviceId
```

Grant Scope：`mcp:connect`、`tools:list`、`tools:call`、`prompts:list`、`prompts:get`。Grant 必须包含 `mcp:connect`，并可通过 `toolNames`/`promptNames` 限制能力名称。

例如服务包含 `A`、`B`、`C` 三个 Tools 时，可为 Client 1 配置 `toolNames: ["A", "B"]`，为 Client 2 配置 `toolNames: ["C"]`。两个 Grant 都包含 `tools:list` 和 `tools:call` 后，对应 API Key 只能列出并调用各自白名单内的 Tools。

### Builds 与审计

```text
GET /builds?limit=100
GET /audit?limit=100&outcome=FAILED&action=POST
```

Build 查询返回持久化的 `INSPECT`/`BUILD` Job、阶段、状态、尝试次数和错误码。Audit 查询支持结果与动作筛选，管理员和审计员可读。

审计中间件记录非 GET 管理请求的 Actor、HTTP 动作、目标路径、状态码、耗时和 Request ID。它不会记录请求 Body、API Key、Tool 输入输出或 Prompt 内容。

## 错误和并发约定

管理错误使用稳定代码：

- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `CONFLICT`
- `IMMUTABLE_VERSION`
- `INVALID_STATE`

修改请求携带正整数 `expectedRevision`。版本不匹配返回 `409 CONFLICT`。发布和回滚还会使用数据库事务和行锁，保证一个服务只有一个 `PUBLISHED` 版本。

## 测试

```bash
pnpm --filter @open-agent-tools/mcp-worker test
pnpm --filter @open-agent-tools/mcp-worker typecheck
pnpm --filter @open-agent-tools/mcp-worker lint
```

这些命令覆盖共用包中的管理 API 与后台 Worker，无需再为已删除的 Control Plane 包重复执行。

PostgreSQL 测试只有在设置 `TEST_DATABASE_URL` 时运行，并会删除、重建目标数据库的 `public` Schema。必须使用专用测试库：

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mcp_test \
  pnpm --filter @open-agent-tools/mcp-worker test
```

## 当前限制

- 管理 API 当前没有身份认证或用户隔离，只适用于本机开发或受信网络。
- 创建接口尚未支持 `REMOTE_MCP`。
- 完整的“从已发布版本自动分叉新草稿”流程仍需补全。
- 尚未提供 Execution 查询 API；Build 和 Audit 查询当前最多返回 200 条记录。
- 审计导出、归档、保留策略和分布式 Gateway Cache Invalidation 仍需接入生产基础设施。
