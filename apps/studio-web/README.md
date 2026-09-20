# Studio Web

`@open-agent-tools/studio-web` 是统一可视化工作台，包含 Agent 对话、MCP 管理与真实 Tool 调用、RAG 知识库、知识图谱、多源问数和可拖拽工作流编排。

## 多源问数

- 在「设置 → Schema 数据源」配置多个 MySQL / PostgreSQL 只读连接；连接串使用服务端 AES-256-GCM 加密存储。
- 支持默认源、启停、连接测试、配置复制、表范围过滤、Schema 同步状态和目录预览。
- 问数工作台可运行时切换数据源；catalog、Schema 图谱、SQL 表边界与查询连接均按 `sourceId` 隔离。
- `REPORT_DATABASE_URL` / `SCHEMA_SOURCE_URL` 会作为只读环境源继续生效，便于旧部署平滑迁移。

当前连接器支持 MySQL 和 PostgreSQL。PostgreSQL 可指定目标 Schema（默认 `public`）。对外部署仍需在网关层为 `/api/admin/schema-sources` 增加管理员鉴权，并按租户限制可见数据源。

## RAG 资产运营

- 文档视图支持固定/语义切分、阈值配置、上传、分块预览、显示标题和标签维护、限定当前文档检索及赞/踩反馈。
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
