# MCP Node.js Runtime

[English](./README_EN.md) | [平台总览](../../README.md)

`runtimes/nodejs` 包含托管 Tool 的 Node.js 20 基础镜像、容器内 Runner，以及用于集成测试的 Echo Tool Fixture。Worker 基于该镜像构建每个 Tool 的不可变 OCI 镜像，并在无网络、非 root、只读文件系统的容器中执行它。

当前只支持 Node.js 20、ESM 和 npm。

## 目录结构

```text
runtimes/nodejs/
  Dockerfile                    Runner 基础镜像
  runner/                       @open-agent-tools/mcp-nodejs-runner
  fixtures/
    echo-package/               示例 Tool 包与测试镜像
    input.json                  示例 Runner 输入
```

## Tool 包契约

Tool ZIP 根目录必须包含 `mcp.json`、ESM `package.json`、npm `package-lock.json` 和 Manifest 指定的 `.js` 入口。入口模块必须导出名为 `handlers` 的对象：

```js
export const handlers = {
  async echoHandler(args, context) {
    return {
      content: [{ type: "text", text: args.value }],
      structuredContent: { requestId: context.requestId },
    };
  },
};
```

Manifest 中每个 Tool 的 `handler` 字段用于查找 `handlers[handler]`。Handler 接收：

1. MCP `tools/call` 的参数对象。
2. 只读上下文：`requestId`、`serviceId`、`versionId`、`clientId` 和 `deadlineAt`。

Handler 必须返回符合 MCP `CallToolResult` 的普通 JSON 值，并包含 `content` 数组。不接受函数、Symbol、Accessor、循环引用、稀疏数组、非有限数字或 Class Instance。Runner 会在缺省时把 `isError` 补为 `false`。

完整 Manifest 格式见 [MCP Contracts](../../packages/mcp-contracts/README.md)。可运行样例见 [Echo Fixture](./fixtures/echo-package/mcp.json)。

## Runner I/O

CLI 默认路径：

| 环境变量           | 默认值                  | 说明               |
| ------------------ | ----------------------- | ------------------ |
| `MCP_PACKAGE_ROOT` | `/app`                  | Tool 包根目录      |
| `MCP_TOOL_INPUT`   | `/run/tool/input.json`  | 只读调用输入       |
| `MCP_TOOL_OUTPUT`  | `/run/tool/output.json` | 独占创建的结果文件 |

输入必须符合共享的 `ToolRunnerInputSchema`。输出是 MCP `CallToolResult` JSON，默认最大 1 MiB。Runner 以 `0600` 权限创建输出文件，并拒绝覆盖已存在的路径。

业务错误会转换成不包含异常消息、堆栈和主机路径的安全结果：

```json
{
  "content": [{ "type": "text", "text": "Tool execution failed." }],
  "isError": true,
  "_meta": {
    "open-agent-tools/error": {
      "code": "HANDLER_FAILED",
      "requestId": "req_123"
    }
  }
}
```

## 稳定错误码

| 错误码               | 含义                                                |
| -------------------- | --------------------------------------------------- |
| `INVALID_INPUT`      | 输入文件不是合法 JSON 或不符合 Runner 输入 Schema   |
| `INVALID_MANIFEST`   | `mcp.json` 缺失、无效或未声明 Tool 入口             |
| `TOOL_NOT_FOUND`     | Manifest 中不存在请求的 Tool                        |
| `MODULE_LOAD_FAILED` | 无法加载 Manifest 指定的入口模块                    |
| `HANDLER_NOT_FOUND`  | `handlers` 中不存在对应函数                         |
| `HANDLER_FAILED`     | Handler 抛出异常或 Promise Reject                   |
| `INVALID_RESULT`     | Handler 返回值不是安全、合法的 MCP `CallToolResult` |
| `OUTPUT_LIMIT`       | 序列化结果超过允许的输出字节数                      |

除无法写出任何结果等 Runner 启动级失败外，上述错误会写入输出文件并由 Worker 转换为协议安全响应。

## 构建基础镜像

在仓库根目录执行：

```bash
docker build \
  -f runtimes/nodejs/Dockerfile \
  -t registry.example.com/mcp-runner:local \
  .
```

Dockerfile 使用摘要固定的 Node.js 20 Alpine 镜像，多阶段构建只复制 Runner 所需文件，最终以非 root `node` 用户和固定 EntryPoint 运行。推送后应把 Registry 返回的 `repository@sha256:...` 配置为 Worker 的 `MCP_RUNNER_IMAGE`，不要在生产环境使用可变 Tag。

Runner 镜像只负责进程内校验和调用。无网络、只读根文件系统、CPU/内存/PID/超时及 Capability 限制由 Worker 创建容器时施加。

## 本地开发

```bash
pnpm --filter @open-agent-tools/mcp-nodejs-runner build
pnpm --filter @open-agent-tools/mcp-nodejs-runner test
pnpm --filter @open-agent-tools/mcp-nodejs-runner typecheck
pnpm --filter @open-agent-tools/mcp-nodejs-runner lint
```

Runner 单元测试不需要 Docker。`runner/src/runtime-image.test.ts` 会静态验证基础镜像摘要固定、非 root 用户和固定 EntryPoint；实际容器 E2E 位于 MCP Worker 测试中，需要本机 Docker 和预先构建的测试镜像。

## 当前限制

- 不支持 CommonJS、TypeScript 源码直跑、pnpm/yarn、Python 或 Java。
- 依赖安装阶段使用 `npm ci --ignore-scripts`，依赖 Lifecycle Script 的包不兼容。
- Tool 执行阶段没有网络访问。
- Runner 不负责验证 Tool 参数的 JSON Schema；Gateway 在任务入队前完成该校验。
