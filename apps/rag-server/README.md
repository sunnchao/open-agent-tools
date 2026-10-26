# rag-server · 知识库 API

`@open-agent-tools/rag-server` 为 Studio Web 提供知识库上传、资产目录、分块预览、多路混合检索（向量 + 关键词 + 知识图谱）、可选 LLM 回答和查询质量运营能力。

## 项目架构

RAG 文档是知识来源，Graph 是由分块派生的实体与关系。服务层通过 `KnowledgeBase` 统一入库、删除、建图和对账；HTTP 路由负责请求校验与响应，核心检索、存储和图谱算法继续由 `packages/rag` 提供。

```text
server/
├── index.ts                 # 启动：加载环境、校验鉴权、监听、优雅关闭
├── config.ts                # 解析配置并校验存储选择，无连接副作用
├── runtime.ts               # 装配模型、存储、Rag、KnowledgeGraph 与运营服务
├── app.ts                   # 创建 Express 应用，安装中间件与路由
├── http/                    # 横切 HTTP 设施
│   ├── auth.ts              # runtime / admin 服务间鉴权
│   ├── request-validation.ts # 来源、分组、元数据与路径参数校验
│   ├── health.ts            # 部署能力状态（原 routes/health.ts）
│   └── usage.ts             # LLM 用量 outbox、请求中间件与 trackRagLlm
├── knowledge/               # 文档与图谱生命周期
│   ├── index.ts             # KnowledgeBase：入库、抽取队列、对账与 CRAG
│   └── chunk-settings.ts    # 配置与上传复用的分块设置
├── analytics/               # 查询运营数据
│   ├── index.ts             # RagAnalyticsStore 门面（对外类形状不变）
│   ├── store.ts             # 事件/命中/反馈写入与补列迁移
│   ├── dashboard.ts         # 运营概览与质量报告
│   ├── replay.ts            # 单条查询审计回放
│   ├── quality.ts           # 无答案归因与拒答识别（纯函数）
│   └── types.ts             # 写入/读取契约
├── routes/                  # HTTP 路由（全部为纯依赖注入工厂）
│   ├── documents.ts         # 上传、目录、分块、元数据与级联删除
│   ├── query.ts             # 混合检索、生成、审计回放与反馈
│   ├── graph.ts             # 建图、子图浏览、检索与同步管理
│   └── analytics.ts         # 运营概览与质量报告端点
└── eval/                    # 评测路由、执行器、指标与评测数据
```

```mermaid
flowchart LR
  HTTP[HTTP 路由] --> KB[KnowledgeBase]
  KB --> RAG[Rag：分块与混合检索]
  KB --> GRAPH[KnowledgeGraph：派生图谱与同步状态]
  RAG --> PG[PostgreSQL / pgvector 主存]
  RAG --> ES[可选 Elasticsearch 关键词索引]
  RAG -->|实体、关系与分块引用| GRAPH
  GRAPH --> GDB[图谱 SQLite]
```

- **入库与删除**：上传先完成文档入库，再登记图谱状态、排队抽取；删除同步清理文档和派生图谱。后台任务保留上传请求的工作区用量上下文。
- **检索**：`Rag` 直接接收 `KnowledgeGraph`，按关系中的分块 ID 从当前知识主存回取原文，再与向量、关键词候选做 RRF 融合。子图浏览与检索共用文本格式化，保留实体名称、关系、来源及属性。
- **访问约束**：RAG 与图谱路由复用来源和分组解析，均以知识库目录过滤可见来源；runtime 缺省只读取公开文档。`RAG_GRAPH_RETRIEVAL` 同时约束在线混合检索与评测。
- **存储边界**：PG 保存文档目录和分块；ES 与图谱都是可重建数据。查询审计、反馈、评测与用量保存在独立职责的 `rag.db` SQLite 表中。离线模式可显式选择 SQLite 作为知识主存。
- **组装边界**：只有 `index.ts` 加载环境并监听端口；`createApp(config, runtime)` 可直接用于集成测试，`runtime.close()` 等待后台建图后释放数据库与连接。

## 启动

```bash
pnpm --filter @open-agent-tools/rag-server dev
```

服务默认监听 `http://localhost:4001`。Studio Web 的知识库与图谱管理统一经 Agent Server 的 `/api/admin/rag/*` BFF 转发，服务 token 由服务端携带。

默认启动需要 `RAG_PG_URL` 或 `DATABASE_URL`；缺少连接配置或 `RAG_STORE` 值无效时启动即报错。离线开发与测试可使用 `RAG_STORE=sqlite`，此时忽略共享环境中的 PG 和 ES 配置。

## API

| 方法     | 路径                            | 说明                                                   |
| -------- | ------------------------------- | ------------------------------------------------------ |
| `GET`    | `/api/health`                   | 能力状态（含 `graphRetrieval`）                        |
| `POST`   | `/api/documents`                | 上传 PDF、TXT、Markdown                                |
| `GET`    | `/api/documents`                | 来源与分块统计                                         |
| `GET`    | `/api/documents/:source/chunks` | 分块详情                                               |
| `PATCH`  | `/api/documents/:source`        | 更新展示标题和标签                                     |
| `DELETE` | `/api/documents/:source`        | 删除来源（级联清理派生的图谱实体与关系）               |
| `POST`   | `/api/query`                    | 多路混合检索（向量 + 关键词 + 图谱）与可选生成回答     |
| `PUT`    | `/api/query/:queryId/feedback`  | 提交或更新赞/踩反馈                                    |
| `GET`    | `/api/analytics/overview`       | 查询质量与运营概览                                     |
| `POST`   | `/api/graph/retrieve`           | 子图检索（种子定位 + 多跳扩展，供图谱视图/工作流节点） |
| `GET`    | `/api/graph/sync-status`        | 知识库与图谱库一致性快照                               |
| `POST`   | `/api/graph/reconcile`          | 一键对账：清理孤儿并重建缺失/过期来源                  |

`POST /api/query` 请求可带 `graph?: boolean`（默认 `true`）与 `graphHops?: number`（默认 2，限制 1..4）。响应新增 `graph` 对象（`enabled` / `seeds` / `entities` / `relations` / `chunkHits` / `context`），`retrieval` 增加 `graphEnabled`、`graphHits` 与 `timingsMs.graphMs`，`chunks[].debug.channels` 可包含 `"graph"`，并新增 `graphScore` / `graphRank`。部署侧可用 `RAG_GRAPH_RETRIEVAL=false` 全局关闭图谱通道（此时请求体无法再开启）。图谱上下文会作为「【知识图谱】」区块拼入 LLM 提示词。

同名文档重传会在向量生成成功后原子替换分块并递增版本；失败时保留旧版本。历史 SQLite 会自动补齐文档目录。查询响应包含 `queryId`，运营数据默认保留 90 天，可通过 `RAG_QUERY_RETENTION_DAYS` 调整。

上传时可通过 `chunkStrategy` 选择 `fixed` 或 `semantic`：

- `fixed`：按 Markdown 结构、段落、句读和最大长度切分，支持自定义 `separators`。
- `semantic`：先拆为句/段语义单元，再根据相邻 Embedding 余弦相似度切分；`semanticThreshold` 越高，切分越细，`chunkSize` 仍作为最大块长度保护。

语义切分必须配置 `OPENAI_API_KEY` 和可用的 Embeddings 模型；能力不可用时 API 返回 400，不会静默退化成固定切分。

环境变量见 `.env.example`。运营数据库默认 `apps/rag-server/rag.db`（SQLite 知识主存模式也使用此文件），图谱库默认 `apps/rag-server/rag-graph.db`；`RAG_GRAPH_RETRIEVAL=false` 可关闭混合检索中的图谱通道，`RAG_AUTO_EXTRACT=false` 则上传后不自动建图、改由对账触发。

`POST /api/query` 的通道开关：默认三路召回（向量 + 关键词 + 图谱）；`graph: false` 关闭图谱通道，`keyword: false` 关闭 BM25 关键词通道，两者同时传即为**仅向量召回**。响应 `retrieval.keywordEnabled` 仅在关键词通道关闭时出现 `false`，`retrieval.graphEnabled` 反映图谱通道是否参与本次检索；审计 trace 同样记录 `keywordEnabled`，用于回放「仅向量」请求。

## 存储后端：PostgreSQL(pgvector) + Elasticsearch

默认 `RAG_STORE=pgvector`：**PostgreSQL + pgvector** 存向量与文档目录，是唯一 Source of Truth；
配置了 `RAG_ES_NODE` 时，内容会同步一份到 **Elasticsearch** 承担 BM25 关键词召回。
向量 / 关键词两路在 `retriever.ts` 里照旧做 RRF 融合，检索语义与之前一致。

```bash
# 0. 一次性：给现有 PG 装 pgvector（Alpine 官方仓库的包是按 PG18 编译的，16 需源码编译）
scripts/install-pgvector.sh agent-demo-postgres mcp_management
#    或直接用自带扩展的官方镜像 pgvector/pgvector:pg16

# 1. 起 rag-server（默认就是 pgvector；ES 可选，不配也能跑）
RAG_PG_URL=postgresql://postgres:postgres@192.168.31.228:5432/mcp_management \
RAG_ES_NODE=http://localhost:9200 \
  pnpm --filter @open-agent-tools/rag-server dev
curl http://127.0.0.1:4001/api/health  # store=pgvector、keywordStore=elasticsearch
```

| 变量                        | 默认       | 说明                                                                   |
| --------------------------- | ---------- | ---------------------------------------------------------------------- |
| `RAG_STORE`                 | `pgvector` | `pgvector`（`pg`/`postgres` 为别名）/ `elasticsearch` / `sqlite`（旧） |
| `RAG_PG_URL`                | 无（必填） | PostgreSQL 连接串，缺省回退 `DATABASE_URL`                             |
| `RAG_PG_TABLE_PREFIX`       | `rag`      | 实际表 `<prefix>_chunks` / `<prefix>_documents`                        |
| `RAG_PG_DIMS`               | `1536`     | 向量维度，须与 embedding 模型一致（`BAAI/bge-m3=1024`）                |
| `RAG_PG_METRIC`             | `cosine`   | `cosine` / `l2` / `inner_product`                                      |
| `RAG_ES_NODE`               | 无         | 配置后启用关键词通道并自动双写；不配则关键词走 PG 的 ILIKE 兜底        |
| `RAG_ES_INDEX_PREFIX`       | `rag`      | ES 索引 `<prefix>-chunks` / `<prefix>-documents`                       |
| `RAG_ES_SYNC_MODE`          | `lenient`  | ES 写入失败：`lenient` 只告警 / `strict` 入库失败                      |
| `RAG_ES_QUERY_MODE`         | `degrade`  | ES 查询失败：`degrade` 降级为仅向量 / `strict` 直接报错                |
| `RAG_ES_REQUEST_TIMEOUT_MS` | `3000`     | ES 请求超时；ES 不可用时靠它快速降级，避免每次查询白等                 |

注意：

- **PG 是主存**：目录、分块明细、计数都以 PG 为准；ES 只是派生的关键词索引，
  可随时用 `HybridVectorStore.resync()` 从 PG 全量重建，因此无需担心两边写冲突。
- `replaceSource` 在 PG 下是**单事务**（`BEGIN … 删除旧分块 → 写新分块 → upsert 目录 … COMMIT`），
  比 ES 的 `delete_by_query + bulk` 更接近原子；embedding 失败时旧版本保留。
- 维度在**建表时固定**：换 embedding 模型必须先 `DROP TABLE <prefix>_chunks, <prefix>_documents` 再重跑
  （代码检测到维度不一致会直接报错，而不是写入脏数据）。
- ES 不可用时不会拖垮检索：关键词通道降级为空候选，向量通道照常返回，日志里有一条 `[rag] keyword ...` 告警。
- 旧 SQLite 知识库可一次性迁移到 PG（幂等、保留 title/tags/ACL、分块 id 不变）：

  ```bash
  node scripts/migrate-rag-sqlite-to-pg.mjs --dry-run   # 先看统计
  node scripts/migrate-rag-sqlite-to-pg.mjs --es        # --es 同时写 ES
  ```

  两个迁移/补同步脚本都会自动读取 `apps/rag-server/.env`（命令行内联变量优先），
  所以不必重复敲 `RAG_PG_URL` / `RAG_ES_NODE`。

- ES 恢复后补齐关键词索引（`lenient` 模式下入库成功但 ES 缺数据时用，无需重传文档）：

  ```bash
  node scripts/resync-rag-es.mjs --dry-run   # 列出 PG 里的来源与分块数
  node scripts/resync-rag-es.mjs             # 或 --source a.md 只重建单个来源
  ```

- `RAG_ES_NODE` 指向远端时确认该地址对**本机**可达（如 `curl http://10.144.0.1:9200/` 有 JSON 返回）。
  若远端 ES 只绑定了 `127.0.0.1`（仓库里的 compose 文件就是这种写法），需改成对外绑定，
  或在本机开 SSH 隧道 `ssh -N -L 9200:127.0.0.1:9200 user@<es-host>` 后把 `RAG_ES_NODE` 设回 `http://localhost:9200`。

- 查询日志 / 评测集 / 用量统计仍落在 `rag.db`（SQLite 文件），图谱仍是 `rag-graph.db`；本次只把**知识库**迁出 SQLite。
- 无 `RAG_PG_URL` 时 `packages/rag/test/store-pgvector.test.ts` 的集成用例自动跳过；
  有 PG 时 `RAG_PG_URL=... pnpm --filter @open-agent-tools/rag test` 即跑真机。

## 验证

```bash
pnpm --filter @open-agent-tools/rag build
pnpm --filter @open-agent-tools/rag --filter @open-agent-tools/rag-server test
pnpm --filter @open-agent-tools/rag --filter @open-agent-tools/rag-server typecheck
pnpm --filter @open-agent-tools/rag-server test:e2e
```

HTTP 集成测试使用临时 SQLite，覆盖整套中间件、上传后自动建图、带 `%` 文件名、图谱引用回取、审计反馈、两类检索的 ACL、手动对账和级联删除。端到端脚本显式选择 SQLite，不依赖 PG、ES 或模型网关。
