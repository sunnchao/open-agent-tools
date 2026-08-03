# MCP Node.js Runtime

[中文](./README.md) | [Platform overview](../../README_EN.md)

`runtimes/nodejs` contains the Node.js 20 base image for managed Tools, the in-container Runner, and an Echo Tool fixture used by integration tests. The Worker builds each Tool into an immutable OCI image based on this runtime and executes it in a network-disabled, non-root container with a read-only root filesystem.

Only Node.js 20, ESM, and npm are currently supported.

## Layout

```text
runtimes/nodejs/
  Dockerfile                    Runner base image
  runner/                       @open-agent-tools/mcp-nodejs-runner
  fixtures/
    echo-package/               Example Tool package and test image
    input.json                  Example Runner input
```

## Tool package contract

The root of a Tool ZIP must contain `mcp.json`, an ESM `package.json`, an npm `package-lock.json`, and the `.js` entry declared by the manifest. The entry module must export an object named `handlers`:

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

Each Tool's `handler` field in the manifest selects `handlers[handler]`. A handler receives:

1. The argument object from MCP `tools/call`.
2. A read-only context containing `requestId`, `serviceId`, `versionId`, `clientId`, and `deadlineAt`.

A handler must return a plain JSON value that conforms to MCP `CallToolResult` and contains a `content` array. Functions, symbols, accessors, circular references, sparse arrays, non-finite numbers, and class instances are rejected. The Runner defaults a missing `isError` to `false`.

See [MCP Contracts](../../packages/mcp-contracts/README_EN.md) for the complete manifest format and [Echo Fixture](./fixtures/echo-package/mcp.json) for a runnable example.

## Runner I/O

CLI defaults:

| Environment variable | Default                 | Description                     |
| -------------------- | ----------------------- | ------------------------------- |
| `MCP_PACKAGE_ROOT`   | `/app`                  | Tool package root               |
| `MCP_TOOL_INPUT`     | `/run/tool/input.json`  | Read-only invocation input      |
| `MCP_TOOL_OUTPUT`    | `/run/tool/output.json` | Exclusively created result file |

Input must conform to the shared `ToolRunnerInputSchema`. Output is MCP `CallToolResult` JSON and is limited to 1 MiB by default. The Runner creates the output with mode `0600` and refuses to overwrite an existing path.

Application failures become safe results without exception messages, stacks, or host paths:

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

## Stable error codes

| Code                 | Meaning                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `INVALID_INPUT`      | The input is not valid JSON or does not match the Runner input schema |
| `INVALID_MANIFEST`   | `mcp.json` is missing, invalid, or has no Tool entry                  |
| `TOOL_NOT_FOUND`     | The requested Tool is not present in the manifest                     |
| `MODULE_LOAD_FAILED` | The manifest entry module cannot be loaded                            |
| `HANDLER_NOT_FOUND`  | The corresponding function is missing from `handlers`                 |
| `HANDLER_FAILED`     | The handler throws or rejects                                         |
| `INVALID_RESULT`     | The handler return value is not a safe, valid MCP `CallToolResult`    |
| `OUTPUT_LIMIT`       | The serialized result exceeds the configured byte limit               |

Except for startup-level failures where no result can be written, these errors are written to the output file and converted by the Worker into protocol-safe responses.

## Building the base image

Run from the repository root:

```bash
docker build \
  -f runtimes/nodejs/Dockerfile \
  -t registry.example.com/mcp-runner:local \
  .
```

The Dockerfile uses a digest-pinned Node.js 20 Alpine image, copies only Runner dependencies through a multi-stage build, and runs with the non-root `node` user and a fixed entry point. After pushing it, configure the Registry's `repository@sha256:...` value as the Worker's `MCP_RUNNER_IMAGE`; do not use a mutable tag in production.

The Runner image handles only in-process validation and invocation. The Worker applies network isolation, a read-only root filesystem, CPU/memory/PID/time limits, and Linux capability restrictions when it creates the container.

## Local development

```bash
pnpm --filter @open-agent-tools/mcp-nodejs-runner build
pnpm --filter @open-agent-tools/mcp-nodejs-runner test
pnpm --filter @open-agent-tools/mcp-nodejs-runner typecheck
pnpm --filter @open-agent-tools/mcp-nodejs-runner lint
```

Runner unit tests do not require Docker. `runner/src/runtime-image.test.ts` statically verifies the pinned base-image digest, non-root user, and fixed entry point. The actual container E2E lives in the MCP Worker tests and requires local Docker plus pre-built test images.

## Current limitations

- CommonJS, direct TypeScript execution, pnpm/yarn, Python, and Java are not supported.
- Dependency installation uses `npm ci --ignore-scripts`; packages that require lifecycle scripts are incompatible.
- Tool execution has no network access.
- The Runner does not validate Tool arguments against their JSON Schema; the Gateway performs that check before enqueueing the job.
