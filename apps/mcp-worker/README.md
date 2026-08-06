# MCP Worker

[English](./README_EN.md) | [平台总览](../../README.md)

`@open-agent-tools/mcp-worker` 是 MCP 平台的受信任后台执行组件。一个 Worker 进程同时消费 Artifact 检查/构建队列和 Tool 执行队列，并通过 Docker 隔离不受信任的用户代码。

Worker 拥有 Docker、对象存储、Registry、PostgreSQL 和 Redis 访问权限，应部署在独立的受限网络中，不能暴露到公网。

## 代码结构

`src` 按依赖方向分层：入口 → 队列 → 服务 → 基础设施。

```
src/
├── index.ts                     # 进程入口（组合根，装配所有依赖）
├── workers/                     # BullMQ 队列消费层
│   ├── build-queue.ts           # 构建队列：Artifact 检查与 Tool 构建
│   └── execution-queue.ts       # 执行队列：运行已发布的 Tool 镜像
├── services/                    # 领域服务层（业务流程编排 + 端口接口定义）
│   ├── artifact-inspection.ts   # Artifact 检查服务
│   └── tool-build.ts            # Tool 构建服务
└── infrastructure/              # 基础设施适配层（外部依赖的具体实现）
    ├── archive.ts               # ZIP 检查与安全解压
    ├── node-package.ts          # Node.js 包与 Manifest 校验
    ├── docker/                  # Docker 相关：执行运行时、构建命令、Smoke 验证、镜像构建
    ├── platform/                # 平台命令执行（spawn）
    ├── repository/              # PostgreSQL 持久化
    └── storage/                 # S3 对象存储（Artifact 下载、SBOM 上传）
```

依赖方向为 `infrastructure` 向上提供端口实现、`services` 编排业务流程、`workers` 消费队列，各层不反向依赖。

## Worker 模式

进程启动后创建两类 BullMQ Worker：

| 队列     | 常量                 | 工作内容                      |
| -------- | -------------------- | ----------------------------- |
| 构建队列 | `mcp-tool-build`     | Artifact 检查和 Tool 镜像构建 |
| 执行队列 | `mcp-tool-execution` | 运行已发布的 Tool 镜像        |

构建队列根据 PostgreSQL 中持久化 Job 的 `kind` 执行 `INSPECT` 或 `BUILD`，确保任务重新投递时可以幂等处理。

## Artifact 检查流程

1. 从 S3/MinIO 流式下载 ZIP 到私有临时目录。
2. 校验实际字节数和 SHA-256 是否与 Control Plane 确认值一致。
3. 检查 ZIP 条目、路径、文件类型、压缩算法和资源上限。
4. 安全解压，防止路径穿越、链接、特殊文件和路径冲突。
5. 读取并校验 `mcp.json`、`package.json` 和 `package-lock.json`。
6. 确认 Node.js 20、ESM、npm Lockfile 和入口文件约束。
7. 将 Manifest 中的 Tools/Prompts 导入对应草稿版本。
8. 将检查结果和稳定错误码写回 PostgreSQL。

默认 ZIP 上限：

| 项目         | 上限    |
| ------------ | ------- |
| 压缩后大小   | 50 MiB  |
| 解压后总大小 | 200 MiB |
| 条目数量     | 10,000  |
| 单个文件     | 25 MiB  |

## Tool 构建流程

1. 重新下载并校验 Artifact。
2. 重新执行 ZIP 和 Node.js 包校验，避免检查后内容漂移。
3. 在隔离构建容器中运行 `npm ci --ignore-scripts --no-audit --no-fund`。
4. Manifest 声明构建时运行唯一允许的 `npm run build`。
5. 在验证容器中加载入口，检查所有 Handler 并执行 Smoke Test。
6. 使用摘要固定的 Runner 基础镜像构建 Tool 镜像；多阶段构建中执行 `npm prune --omit=dev` 裁剪 devDependencies，仅将生产依赖和入口复制进最终镜像。
7. 镜像 tag 以 `mcp-tool:${toolName}-` 为前缀，推送到 `TOOL_IMAGE_REPOSITORY` 并读取 Registry Digest。
8. 使用 Syft 生成 CycloneDX SBOM。
9. 使用 Trivy 扫描 `HIGH,CRITICAL` 漏洞；扫描失败即构建失败。
10. 上传 SBOM，并将 `imageDigest`/`sbomObjectKey` 写回 PostgreSQL。

构建失败使用稳定代码，例如 `NPM_INSTALL_FAILED`、`BUILD_COMMAND_FAILED`、`HANDLER_NOT_FOUND`、`SMOKE_TEST_FAILED`、`IMAGE_BUILD_FAILED`。

## Tool 执行流程

1. 从 BullMQ 读取并校验 `ToolExecutionJob`。
2. 使用 `TOOL_IMAGE_REPOSITORY@sha256:...` 解析不可变镜像。
3. 创建只读输入文件和输出目录。
4. 创建非 root、无网络、只读根文件系统的容器，容器名以 `mcp-tool-${toolName}-` 为前缀。
5. 应用内存、CPU、PID、Capability、日志和 Wall-clock Timeout 限制。
6. Runner 读取 `/run/tool/input.json`，调用 Handler，并写入 `/run/tool/output.json`。
7. Worker 校验输出大小和 MCP `CallToolResult`，再返回 Gateway。
8. 无论成功或失败都删除容器和临时目录。

Tool 失败返回协议安全的 `isError: true` 结果，不向 Client 暴露堆栈、主机路径或 Docker 细节。

## 环境要求

- Docker Engine 和可访问的 Docker daemon
- Docker Buildx
- PostgreSQL 16
- Redis 7
- S3 兼容对象存储
- 可推送/拉取的 OCI Registry
- `syft`
- `trivy`
- 受控 npm Egress Docker Network

## 环境变量

```bash
cp .env.example .env
```

开发脚本通过 Node.js 的 `--env-file` 从 `.env` 加载变量；生产启动仍必须由进程管理器或 Shell 注入变量：

| 变量                    | 必需       | 说明                                                                                |
| ----------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `REDIS_URL`             | 是         | 两个 BullMQ 队列                                                                    |
| `DATABASE_URL`          | 是         | 与 Control Plane 相同的管理数据库                                                   |
| `TOOL_IMAGE_REPOSITORY` | 是         | Tool 镜像 Repository                                                                |
| `MCP_RUNNER_IMAGE`      | 是         | 必须为 `repository@sha256:...`                                                      |
| `NPM_NETWORK`           | 否         | 安装依赖的 Docker Network，默认 `bridge`                                            |
| `DOCKER_SOCKET_PATH`    | 否         | Docker socket 绝对路径；OrbStack 等非默认 context 需要配置                          |
| `BUILDX_ATTESTATIONS`   | 否         | Buildx provenance/SBOM attestations，默认 `true`；本地 docker driver 可设为 `false` |
| `EXECUTION_CONCURRENCY` | 否         | Tool 并发，默认 `4`                                                                 |
| `BUILD_CONCURRENCY`     | 否         | 检查/构建并发，默认 `2`                                                             |
| `ARTIFACT_S3_BUCKET`    | 是         | Artifact 和 SBOM Bucket                                                             |
| `ARTIFACT_S3_REGION`    | 否         | 默认 `us-east-1`                                                                    |
| `ARTIFACT_S3_ENDPOINT`  | 否         | MinIO 等自定义 Endpoint                                                             |
| `AWS_ACCESS_KEY_ID`     | 视环境而定 | S3 凭据                                                                             |
| `AWS_SECRET_ACCESS_KEY` | 视环境而定 | S3 凭据                                                                             |

## 启动

Bash/Zsh 示例：

```bash
pnpm --filter @open-agent-tools/mcp-worker dev
```

生产构建：

```bash
pnpm --filter @open-agent-tools/mcp-worker build
pnpm --filter @open-agent-tools/mcp-worker start
```

进程没有 HTTP 端口。健康状态应由进程存活、BullMQ Worker 状态、队列指标和 PostgreSQL Job 心跳共同监控。

## Runner 镜像

先在仓库根目录构建并推送 Runner：

```bash
docker build -f runtimes/nodejs/Dockerfile -t registry.example.com/mcp-runner:local .
docker push registry.example.com/mcp-runner:local
docker inspect --format='{{index .RepoDigests 0}}' registry.example.com/mcp-runner:local
```

把得到的 `repository@sha256:...` 写入 `MCP_RUNNER_IMAGE`。Worker 会拒绝未固定摘要的 Runner 镜像。

## Docker 安全配置

执行容器默认使用：

- `NetworkMode: none`
- 非 root Runner 用户
- `ReadonlyRootfs: true`
- `/tmp` 和 `/run/tool` Tmpfs
- `CapDrop: ALL`
- `no-new-privileges`
- 最大 64 PID
- 无 Host Mount 和 Docker Socket Mount
- 按 Manifest 限制内存、CPU 和超时

Worker 自身需要访问 Docker Socket，但用户 Tool 容器绝不能获得该 Socket。

## 测试

```bash
pnpm --filter @open-agent-tools/mcp-worker test
pnpm --filter @open-agent-tools/mcp-worker typecheck
pnpm --filter @open-agent-tools/mcp-worker lint
```

部分测试依赖：

- PostgreSQL：设置专用 `TEST_DATABASE_URL`；相关测试会删除并重建目标数据库的 `public` Schema。
- Docker E2E：本机 Docker 可用，并已构建测试 Runner/Fixture 镜像。
- S3、Registry、Syft、Trivy 的生产集成应在部署流水线中追加验证。

## 当前限制

- 仅支持 Node.js 20、ESM 和 npm Lockfile。
- 构建期间 npm Lifecycle Script 被 `--ignore-scripts` 禁用；依赖这些脚本的包无法构建。
- 只支持无网络 Tool 执行。
- 当前进程把检查、构建和执行 Worker 放在一起；生产环境可根据权限与扩缩容需求进一步拆分部署入口。
- Registry 签名、远程证明和 Kubernetes Sandbox 尚未接入。
