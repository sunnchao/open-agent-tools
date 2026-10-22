# Studio Web

`@open-agent-tools/studio-web` 是统一可视化工作台，包含 Agent 对话、MCP 管理与真实 Tool 调用、RAG 知识库（内置知识图谱视图与图谱增强检索）、多源问数和可拖拽工作流编排。

> 知识图谱已并入知识库：导航中不再有独立「图谱」工作区，`#/graph` 旧链接会进入知识库的图谱视图（`#/rag/graph`）。

## MCP 服务环境变量

在「MCP → 服务」选择服务，点击「环境变量」配置 `TAVILY_API_KEY` 等运行变量。所有版本的 Tool 共享服务配置，保存后下一次调用生效，无需重新构建或发布。

- 支持新增、替换和删除变量；已保存的值不会回显，未编辑的值会保留。
- 变量名使用字母、数字和下划线，首字符不能是数字；最多 64 个变量、每个值最多 8192 字符，总计最多 64 KiB UTF-8。
- Runner 控制变量（`MCP_*`）、Node.js 加载配置（`NODE_OPTIONS` / `NODE_PATH`）和系统加载路径不能覆盖。
- 环境变量保存在管理数据库，Worker 在执行前按服务读取，并通过 Docker `Env` 注入；队列任务、Tool 参数和镜像中不包含这些值。

部署时先应用 `apps/mcp-worker/drizzle/0004_mcp_service_environment.sql` 所在的迁移历史并重启后台 Worker。联网 Tool 还需要在版本的运行限制中选择 `bridge`。

## MCP 运行限制

代码包检查完成后，右侧「配置与预览 → 运行限制」显示从 `mcp.json` 导入的 `timeoutMs`、`memoryMb`、`cpuMillis` 和 `network`。点击「编辑限制」可调整并保存，保存使用版本 revision 检查并发冲突。

- DRAFT、FAILED 和未发布的 READY 版本可修改，构建过程保留修改后的值。
- PUBLISHED 和 SUPERSEDED 版本只读，需创建新草稿再修改。
- `none` 禁止联网，`bridge` 允许联网；限制应用于当前版本的所有 Tool，发布后由 Worker 执行。
- 新上传的包若声明 `bridge`，构建时应使用包含最新 contracts 的 Runner 基础镜像。

## 远端 MCP 服务

- 在「MCP → 服务」新建服务时选择「远端代理」，填写上游地址（Streamable HTTP / SSE）、超时、自定义请求头和 Token；创建前可「测试连接」验证上游可达，创建后版本自动发布并开始代理。
- 远端版本在版本面板展示「上游 MCP 接入」卡片：脱敏显示地址与 Token 状态，DRAFT/FAILED/READY 版本可编辑上游配置并重新测试，已发布版本需「创建草稿」后再改。
- Token 只写不回显：编辑时留空=保留已有，清空需勾选清除；版本测试接口会自动用已保存 Token 补齐。
- 远端版本的本地 Prompts 仍可在草稿中维护，由网关直接渲染；运行限制面板对远端版本隐藏（超时由上游配置控制）。

## 多源问数

- 在「设置 → Schema 数据源」配置多个 MySQL / PostgreSQL 只读连接；连接串使用服务端 AES-256-GCM 加密存储。
- 支持默认源、启停、连接测试、配置复制、表范围过滤、Schema 同步状态和目录预览。
- 问数工作台可运行时切换数据源；catalog、Schema 图谱、SQL 表边界与查询连接均按 `sourceId` 隔离。
- `REPORT_DATABASE_URL` / `SCHEMA_SOURCE_URL` 会作为只读环境源继续生效，便于旧部署平滑迁移。

当前连接器支持 MySQL 和 PostgreSQL。PostgreSQL 可指定目标 Schema（默认 `public`）。对外部署仍需在网关层为 `/api/admin/schema-sources` 增加管理员鉴权，并按租户限制可见数据源。

## RAG 资产运营

- 文档视图支持固定/语义切分、阈值配置、上传、分块预览、显示标题和标签维护、限定当前文档检索及赞/踩反馈。
- 知识库分「文档 / 图谱 / 运营分析」三个视图；图谱视图与知识来源列表共用选中文档，提供子图检索、实体索引、关系详情、建图用量与图谱一致性对账。
- 检索默认开启「图谱检索（多路召回）」：RAG Server 并行执行向量、关键词与图谱三路召回，图谱命中关系回溯到真实分块后参与 RRF；结果展示每条命中的通道（向量 / 关键词 / 图谱）、图谱分数与候选排名，以及图谱种子、实体关系计数和子图上下文。检索框下方的「图谱检索（多路召回）」复选框可关闭图谱召回，此时请求体同时下发 `graph: false` 与 `keyword: false`，检索退化为**仅向量召回**（不再融合 BM25 关键词）；重新勾选即恢复三路。
- 运营分析汇总最近 14 天查询量、空召回率、平均延迟、好评率、热门来源和最近查询。
- 查询统计由 RAG Server 保存，Langfuse 继续负责模型与检索 trace，两者职责分离。

## 工作流发布与 Service API

- 工作流草稿保存到 Agent Server 的 SQLite，支持多工作流、乐观锁自动保存、不可变发布版本和回滚。
- 「访问点」提供工作流级 API Key、每分钟限流、OpenAPI 3.1、cURL/JavaScript/Python 示例和最近运行。
- API Key 明文只在创建时返回一次；调用端必须使用服务端环境变量保存，不应写入浏览器代码。
- 公开运行接口只接收已发布工作流的输入，不接收节点或连线定义。

```http
POST /v1/workflows/{slug}/run
Authorization: Bearer wf.<key-id>.<secret>
Content-Type: application/json
Idempotency-Key: optional-request-id

{
  "inputs": { "query": "Hello" },
  "response_mode": "blocking",
  "user": "external:user-1"
}
```

运行控制接口：

- `POST /v1/workflow-tasks/{taskId}/stop`
- `GET /v1/workflow-runs/{runId}`
- `GET /v1/workflow-runs/{runId}/events?after={sequence}`
- `GET /v1/workflows/{slug}/schema`

## 工作流运行历史与变量修复

- 编辑器右侧「运行历史」展示最近 50 次编辑器调试与公开 API 调用，可按状态筛选、刷新和查看只读节点轨迹（输入、输出、最终提示词、耗时及 Token）。回放使用当次运行快照，后续草稿修改不会改变历史。
- `POST /api/workflow/run` 可携带 `workflowId`，保存 Studio 运行历史；不携带时仍兼容原有临时调试请求。
- Studio 使用 `GET /api/workflows/:workflowId/runs/:runId/events?after=0` 返回 `{ run, events, graph }`；检查运行与工作流的归属，公开 `/v1` 回放接口继续要求 API Key。管理接口沿用现有受信网络边界。
- 入口来源与模板失效引用提供候选修复按钮；模板只替换当前字段的占位符，MCP JSON 只替换值、不修改键或普通文本；修复支持撤销/重做。
- 首次访问工作流存储时自动兼容旧 SQLite 的 `workflow_runs.version_id NOT NULL`，保留历史事件并增加运行快照表；正式部署升级前请备份数据库。

## 启动

```bash
pnpm --filter @open-agent-tools/studio-web dev
```

默认地址为 `http://localhost:5173`。本地开发代理：

- `/api` -> Agent Server `:3000`
- `/mcp-api` -> MCP Control Plane `:4200`
- `/mcp/services/:slug` -> MCP Gateway `:4100`
- `/rag-api` -> RAG Server `:4001`

`RAG_API_PROXY_TARGET` 可在开发时覆盖 RAG 代理目标，例如 `http://localhost:4011`。

## 验证

```bash
pnpm --filter @open-agent-tools/studio-web typecheck
pnpm --filter @open-agent-tools/studio-web lint
pnpm --filter @open-agent-tools/studio-web test
pnpm --filter @open-agent-tools/studio-web build
```

### 工作流变量

- 在开始节点的“入口变量”中统一声明名称、类型、必填和默认值；其他节点从“输入来源”搜索选择入口变量或直接前置节点输出。
- 输出取值可选择完整结果、本节点输入、内置结果字段，以及单节点测试返回的样例字段。动态字段的实际存在性在运行时检查，高级模式可编辑路径。
- 查询、系统提示词、用户提示词、MCP 参数映射和条件表达式支持“插入变量”；输入 `{{` 可用方向键和 Enter/Tab 补全本节点已绑定的变量。
- 变量改名会更新结构化绑定及相关模板；删除保留失效引用供修复。无效引用可保存草稿，但不能运行或发布。
- 旧工作流首次加载会从现有运行输入引用提取入口声明，保留 `any` 类型；相似名称会提示核对。已发布旧版本继续兼容原入口推导方式。
- 前端和后端共用 `@open-agent-tools/workflow-contracts` 校验。安装后先运行根目录的 `pnpm build:deps`，再启动 Studio 和 Server。

### HTTP 请求与最终输出

- 节点库中的“HTTP 请求”支持 GET、HEAD、POST、PUT、PATCH、DELETE；GET/HEAD 不发送请求体。其他方法可配置 JSON、原始文本或文本 multipart 表单。文件变量与 HTTP 响应逐段转发暂不支持。
- URL、查询参数、请求头、请求体和认证值支持已绑定变量及深度路径，例如 `{{response.items[0].id}}`。查询参数按 `key:value` 分行或用 `&` 分隔，值会自动编码。JSON 中完整的占位符保留数字、布尔和对象类型。
- 响应输出为 `body/status_code/headers/size`；JSON MIME 的 body 解析为 JSON 值，其他响应保留文本，size 为响应字节数。输出选择器支持 `$result.body.items[0].id`。响应上限为 5 MB，最多跟随 5 次重定向，跨来源不转发认证头。
- Basic、Bearer 和自定义头认证可填写固定值或使用变量。请求日志、节点事件、回显结果及历史入口输入视图脱敏；内部执行数据继续供下游使用。导出和剪贴板复制移除固定凭据及用于认证的固定输入/入口默认值。导入后可以保存草稿，补齐认证才能运行或发布。
- “高级执行设置”配置 1–120 秒超时与 0–3 次重试；超时覆盖响应体读取并取消请求。408、429、5xx 与暂时性网络错误可重试；其他 4xx 不自动重试。TLS 验证默认开启，关闭只作用于当前节点请求。
- 服务端可设置 `WORKFLOW_HTTP_ALLOWLIST=api.example.com,internal.example.com`，使用精确 hostname 匹配并逐次检查重定向目标；未配置时允许 HTTP/HTTPS。Host、Content-Length、Connection、Transfer-Encoding 由传输层管理。
- 所有执行到的结束节点输出合并为扁平对象，同名变量由后执行的节点覆盖；未执行分支不贡献结果。Studio `run_done.outputs`、公开 API 与历史最终输出使用同一口径；逐节点快照保存在 `run_done.nodeOutputs`，节点事件继续保留输入输出。

工作流草稿、发布版本、执行快照和用于续跑的内部入口输入沿用现有受信管理存储边界；本次没有引入工作流密钥库或配置加密。含凭据的运行数据不能从脱敏后的历史观测中还原，必要时应重新执行提供凭据的上游节点。
