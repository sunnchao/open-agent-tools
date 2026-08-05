# rag-server · 知识库 API

`@open-agent-tools/rag-server` 为 Studio Web 提供知识库上传、分块预览、混合检索和可选 LLM 回答能力。

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
| `DELETE` | `/api/documents/:source`        | 删除来源                |
| `POST`   | `/api/query`                    | 混合检索与可选生成回答  |

环境变量见 `.env.example`。默认数据库为 `apps/rag-server/rag.db`。
