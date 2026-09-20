# rag-server · 知识库 API

`@open-agent-tools/rag-server` 为 Studio Web 提供知识库上传、资产目录、分块预览、混合检索、可选 LLM 回答和查询质量运营能力。

## 启动

```bash
pnpm --filter @open-agent-tools/rag-server dev
```

服务默认监听 `http://localhost:4001`。Studio Web 将 `/rag-api` 代理到该服务。

## API

| 方法     | 路径                            | 说明                    |
| -------- | ------------------------------- | ----------------------- |
| `GET`    | `/api/health`                   | 能力状态                |
| `POST`   | `/api/documents`                | 上传 PDF、TXT、Markdown |
| `GET`    | `/api/documents`                | 来源与分块统计          |
| `GET`    | `/api/documents/:source/chunks` | 分块详情                |
| `PATCH`  | `/api/documents/:source`        | 更新展示标题和标签      |
| `DELETE` | `/api/documents/:source`        | 删除来源                |
| `POST`   | `/api/query`                    | 混合检索与可选生成回答  |
| `PUT`    | `/api/query/:queryId/feedback`  | 提交或更新赞/踩反馈     |
| `GET`    | `/api/analytics/overview`       | 查询质量与运营概览      |

同名文档重传会在向量生成成功后原子替换分块并递增版本；失败时保留旧版本。历史 SQLite 会自动补齐文档目录。查询响应包含 `queryId`，运营数据默认保留 90 天，可通过 `RAG_QUERY_RETENTION_DAYS` 调整。

上传时可通过 `chunkStrategy` 选择 `fixed` 或 `semantic`：

- `fixed`：按 Markdown 结构、段落、句读和最大长度切分，支持自定义 `separators`。
- `semantic`：先拆为句/段语义单元，再根据相邻 Embedding 余弦相似度切分；`semanticThreshold` 越高，切分越细，`chunkSize` 仍作为最大块长度保护。

语义切分必须配置 `OPENAI_API_KEY` 和可用的 Embeddings 模型；能力不可用时 API 返回 400，不会静默退化成固定切分。

环境变量见 `.env.example`。默认数据库为 `apps/rag-server/rag.db`。
