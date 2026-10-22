# rag-server · 知识库 API

`@open-agent-tools/rag-server` 为 Studio Web 提供知识库上传、资产目录、分块预览、多路混合检索（向量 + 关键词 + 知识图谱）、可选 LLM 回答和查询质量运营能力。

## 启动

```bash
pnpm --filter @open-agent-tools/rag-server dev
```

服务默认监听 `http://localhost:4001`。Studio Web 将 `/rag-api` 代理到该服务。

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

环境变量见 `.env.example`。默认数据库为 `apps/rag-server/rag.db`。图谱库默认 `apps/rag-server/rag-graph.db`；`RAG_GRAPH_RETRIEVAL=false` 可全局关闭图谱检索通道，`RAG_AUTO_EXTRACT=false` 则上传后不自动建图、改由对账触发。

## 存储后端：SQLite / Elasticsearch

默认 `RAG_STORE=sqlite`，零运维单文件跑通；切 ES 只需先起本地集群再切开关：

```bash
# 1. 起 ES + Kibana（单节点演示，数据卷 es-data 持久化）
docker compose -f scripts/docker-compose.elasticsearch.yml up -d
curl http://localhost:9200  # 期望 {"tagline":"You Know, for Search"}

# 2. 切 rag-server 到 ES（另开终端）
RAG_STORE=elasticsearch RAG_ES_NODE=http://localhost:9200 \
  pnpm --filter @open-agent-tools/rag-server dev
curl http://127.0.0.1:4001/api/health  # store 应为 "elasticsearch"
```

| 变量                  | 默认                    | 说明                                                               |
| --------------------- | ----------------------- | ------------------------------------------------------------------ |
| `RAG_STORE`           | `sqlite`                | `sqlite` / `elasticsearch`（`es` 为别名）                          |
| `RAG_ES_NODE`         | `http://localhost:9200` | ES 节点地址                                                        |
| `RAG_ES_INDEX_PREFIX` | `rag`                   | 实际索引 `<prefix>-chunks` / `<prefix>-documents`                  |
| `RAG_ES_DIMS`         | `1536`                  | 向量维度，须与 embedding 模型一致（`text-embedding-3-small=1536`） |

注意：

- ES 索引维度建时固定，换 embedding 模型先删索引重建（维度 mismatch 时 `knn` 会 400，可用 `DELETE /<prefix>-chunks,/<prefix>-documents` 清掉重跑）。
- `replaceSource` 在 SQLite 下是事务原子，在 ES 下是 `delete_by_query + bulk` best-effort，失败重传修复；`title/tags/allowedGroups` 人工运营数据重传不覆盖（与 SQLite 一致）。
- 中文默认 `standard` 分词可用但精度一般；生产中文建议用带 `analysis-ik` 的自定义镜像并把 `content` 改为 `ik_max_word`（`store-elasticsearch.ts` 有标记）。
- 无 `RAG_ES_NODE` 时 `packages/rag/test/store-elasticsearch.test.ts` 的集成用例自动跳过；有 ES 时 `RAG_ES_NODE=http://localhost:9200 pnpm --filter @open-agent-tools/rag test` 即跑真机。
