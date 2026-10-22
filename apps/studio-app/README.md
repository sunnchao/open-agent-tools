# Studio App（React Native / Expo）

`@open-agent-tools/studio-app` 是 `studio-web` 的移动端对等实现：同一套 Agent Server（`:3000`）与 MCP Control Plane（`:4200`）接口，覆盖对话、MCP、知识库（含图谱增强与图谱工具）、连接器、问数、报表、工作流、设置八大工作区。

> 知识图谱已并入知识库：移动端不再有独立「图谱」工作区，图谱检索、实体浏览、关系分布与同步对账都位于知识库页面内；历史 `graph` tab 值会自动降级为 `rag`。

## 运行

```bash
cp apps/studio-app/.env.example apps/studio-app/.env.local  # 按需改地址（Expo 读取 EXPO_PUBLIC_*）
pnpm --filter @open-agent-tools/studio-app dev      # expo start
pnpm --filter @open-agent-tools/studio-app android  # 连真机/模拟器
pnpm --filter @open-agent-tools/studio-app ios
pnpm --filter @open-agent-tools/studio-app web      # Metro Web 预览
```

环境变量：`EXPO_PUBLIC_AGENT_URL`（默认 `http://localhost:3000`）、`EXPO_PUBLIC_MCP_URL`（默认 `http://localhost:4200`，App 内自动拼接 `/api/admin/mcp`）、`EXPO_PUBLIC_MCP_GATEWAY_URL`（默认 `http://localhost:4100`）、`EXPO_PUBLIC_STUDIO_API_TOKEN`。App 内设置页可运行时覆盖并持久化（AsyncStorage），与 Web 的 `localStorage` 键名对齐。

## 验证

```bash
pnpm --filter @open-agent-tools/studio-app typecheck
pnpm --filter @open-agent-tools/studio-app lint
pnpm --filter @open-agent-tools/studio-app test
pnpm --filter @open-agent-tools/studio-app build
```

## 与 Web 的差异（有意为之）

- 工作流画布改为「节点列表 + 连接列表 + JSON 配置」编辑：10 种节点类型、校验、变量绑定、单节点测试、运行、发布/回滚、API Key、运行历史回放全部保留；拖拽画布、自动布局、剪贴板跨应用粘贴改为文本 JSON 导入导出。
- MCP 代码包上传改为「预签名 URL + 二进制直传」：App 侧计算 SHA-256 后走同一套 `upload-url`/`complete-upload` 接口；文件选择器由宿主 App 提供，`uploadArtifact` 接收 `{ name,size,sha256,data }`。
- SSE 在 RN/Hermes 下做了三形态兼容：`ReadableStream` 流式、`text()` 一次性、尾包补 `\n\n` 再解析；`parseSseBuffer` 语义与 Web 一致。
- Gateway 直调不用 `@modelcontextprotocol/sdk` 的 StreamableHTTPClientTransport（其 GET 探测在 RN 下不可靠），改用纯 `fetch` JSON-RPC，兼容 JSON 直回与 SSE 包裝两种响应。

## 移动端专有能力（与 Web 对齐）

- 对话资源绑定：会话内可配 RAG 挂载（含 Top-K 步进器）、SQL 数据源（上限 20）、MCP Tools（含失效绑定清理），与 Web `ChatResourceDrawer` 同语义；Provider/Model 可在会话内切换。
- MCP 客户端授权：创建客户端、发放/吊销 API Key（明文仅显示一次）、授予/移除服务授权、全局配额、用量近 5 条、服务市场订阅。
- 知识库上传：系统文档选择器多选 → `uploadDocuments`（chunkSize/chunkOverlap 可配，默认 1024/50）。
- MCP 代码包上传：版本内「上传代码包」→ 系统选 ZIP → 纯 TS SHA-256（`sha256:` 前缀）→ `upload-url`/`complete-upload` 同链路。
- 导出分享：问数审计导出（CSV/JSON）、用量明细导出（CSV/JSON）→ 缓存落盘 + 系统分享（`expo-sharing`）。
- 设置：企业身份状态卡（OIDC/LDAP）、发布应用身份卡、Schema 数据源全 CRUD（新增/设默认/同步/测试/目录预览/复制/删除）。

## 打包（EAS）

```bash
npx eas-cli build --platform android --profile preview   # 需先 eas login
npx eas-cli build --platform ios --profile preview
```

`eas.json` 已内置 development/preview/production 三档；图标与 splash 为 1024 真机尺寸（`assets/`）。
