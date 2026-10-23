# Studio Client

Web 与 React Native 共用的请求、SSE、导出、图遍历和工作流客户端。公共模块不读取本地存储，也不保存 Token、服务地址或工作区；由平台注入 transport，逐次请求时解析当前设置。

```ts
import { createWorkflowClient } from "@open-agent-tools/studio-client";

const workflow = createWorkflowClient(platformFetch);
const runs = await workflow.fetchWorkflowRuns(workflowId, abortController.signal);
```

工作流管理 DTO 位于 `@open-agent-tools/workflow-contracts`，不依赖 React 或画布组件。Web 可用 `createWorkflowClient<EditorSnapshot>(studioFetch)` 保留自己的画布类型；移动端使用默认的可序列化快照类型。删除接口保留 404 容错，草稿保存透传 `expectedRevision`，运行列表和回放透传取消信号。

`createWorkflowClient` 覆盖列表、详情、创建、复制、删除、保存、发布、回滚、Key 创建/撤销、运行列表与回放。两端已有 API 模块继续导出原来的函数名。运行流事件映射和节点测试仍留在各端，保留各端回调协议。

工作流管理接口保留原有的空/非法 JSON 响应回退；通用 `requestJson` 对成功响应仍使用标准 JSON 解析行为。

```sh
pnpm --filter @open-agent-tools/workflow-contracts --filter @open-agent-tools/studio-client build
pnpm --filter @open-agent-tools/studio-client test
```
