# web-search

联网搜索 MCP 工具。请求格式与下面的 curl 等价：

```bash
curl -X POST "$TAVILY_SEARCH_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TAVILY_API_KEY" \
  -d '{
    "query": "latest AI agent news",
    "topic": "general",
    "search_depth": "basic",
    "include_answer": true,
    "max_results": 5
  }'
```

工具名是 `web_search`。`topic` 支持 `general`、`news`、`finance`；`search_depth` 支持 `basic`、`advanced`；`max_results` 范围是 1 到 10。

## 凭证

密钥只从环境变量读取，不写入工具参数或仓库：

```bash
export TAVILY_API_KEY=th-xxxx-xxxxxxxxxxxx
export TAVILY_SEARCH_URL=https://tavily-proxy.deedvv.dev/api/tavily/search # 可选
```

## 本地验证

`executeLocal` 直接调用 `webSearch` handler，并自动读取本目录的 `.env.local`。已有环境变量优先，不会覆盖。

```bash
npm run local -- "latest AI agent news"
node scripts/local.mjs "latest AI agent news" --max-results 1 --json
```

## 本地运行

Studio 的「MCP → 服务 → 环境变量」可配置 `TAVILY_API_KEY` 和可选的 `TAVILY_SEARCH_URL`，Worker 会在执行时注入。此包声明 `limits.network: "bridge"`，托管执行时允许联网。上传检查后，可在右侧预览面板修改运行限制；旧的禁网版本需创建草稿、改为 `bridge` 并发布。构建声明 `bridge` 的新包时，Runner 基础镜像需包含最新 contracts。

用 stdio MCP 进程运行时，进程继承调用方传入的环境变量：

```json
{
  "name": "web-search",
  "transport": "stdio",
  "command": "node",
  "args": ["packages/function-tools/web-search/src/stdio.js"],
  "env": {
    "TAVILY_API_KEY": "th-xxxx-xxxxxxxxxxxx"
  }
}
```

## 打包

```bash
pnpm --filter @open-agent-tools/function-tools build-package -- --tool=web-search
```
