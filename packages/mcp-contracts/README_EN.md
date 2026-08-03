# MCP Contracts

[中文](./README.md) | [Platform overview](../../README_EN.md)

`@open-agent-tools/mcp-contracts` defines the data contracts shared by the Control Plane, Gateway, Worker, and Node.js Runner. It uses Zod to provide runtime validators and TypeScript types for manifests, Prompt rendering, BullMQ jobs, and Runner I/O.

## Exports

| Category | Main exports                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------ |
| Manifest | `ManagedMcpManifestSchema`, `ManagedToolSchema`, `PromptDefinitionSchema`, `ExecutionLimitsSchema`     |
| Prompt   | `renderPrompt`, `PromptRenderError`, `DEFAULT_MAX_PROMPT_OUTPUT_BYTES`                                 |
| Jobs     | `ArtifactInspectionJobSchema`, `ToolExecutionJobSchema`, `MCP_BUILD_QUEUE`, `MCP_TOOL_EXECUTION_QUEUE` |
| Runner   | `ToolRunnerInputSchema`, `ToolInvocationContextSchema`                                                 |

All object schemas are strict and reject unknown fields.

## `mcp.json` manifest

```json
{
  "schemaVersion": 1,
  "runtime": { "name": "nodejs", "version": "20" },
  "entry": "dist/index.js",
  "build": { "command": "npm run build" },
  "tools": [
    {
      "name": "get_report",
      "description": "Get a report by id",
      "handler": "getReport",
      "inputSchema": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"],
        "additionalProperties": false
      }
    }
  ],
  "prompts": [],
  "limits": {
    "timeoutMs": 30000,
    "memoryMb": 256,
    "cpuMillis": 1000,
    "network": "none"
  }
}
```

Manifest rules:

- `schemaVersion` is currently fixed to `1`.
- At least one Tool or Prompt is required. Names must be unique within each capability type, but a Tool and Prompt may share a name.
- Tool, Prompt, and argument names must match `[a-zA-Z][a-zA-Z0-9_-]{0,63}`.
- A Tool `handler` must be a valid JavaScript export identifier.
- A manifest containing Tools must declare Node.js `20`, a safe relative `.js` entry, and execution limits.
- A Prompt-only manifest cannot contain `runtime`, `entry`, `build`, or `limits`.
- The only supported build command is `npm run build`, and `build` requires an `entry`.
- The top level of a Tool `inputSchema` must be a JSON Schema object.
- `network` is currently fixed to `none`; `timeoutMs` is capped at 120 seconds, memory at 4096 MiB, and CPU at 8000 millicores.

## Prompt definitions and rendering

Prompts support ordered `user`/`assistant` text messages and declared string arguments. Templates support only exact `{{name}}` placeholders. Whitespace, property access, conditionals, helpers, and other expressions are not supported.

```ts
import { renderPrompt } from "@open-agent-tools/mcp-contracts";

const rendered = renderPrompt(definition, {
  reportId: "report-1",
});
```

- Undeclared, missing required, and non-string arguments raise `PromptRenderError`.
- An omitted optional argument renders as an empty string.
- Argument values are substituted once; `{{...}}` inside a value is not interpreted again.
- Prompt templates are limited to 64 KiB in total, and rendered output defaults to a 256 KiB limit.

## Queue contracts

| Queue                     | Constant             | Payload schema                |
| ------------------------- | -------------------- | ----------------------------- |
| Artifact inspection/build | `mcp-tool-build`     | `ArtifactInspectionJobSchema` |
| Tool execution            | `mcp-tool-execution` | `ToolExecutionJobSchema`      |

An Artifact job pins the object key, SHA-256, byte size, service version, and revision. A Tool execution job pins the image digest, Tool name, arguments, Client, deadline, and execution limits. Producers and consumers should validate payloads at their boundaries.

## Runner input

`ToolRunnerInputSchema` allows only this data into a Tool container:

```json
{
  "requestId": "req_123",
  "toolName": "get_report",
  "arguments": { "id": "report-1" },
  "context": {
    "serviceId": "svc_123",
    "versionId": "ver_3",
    "clientId": "client_8",
    "deadlineAt": "2026-07-31T12:00:30.000Z"
  }
}
```

Bearer Tokens, API Keys, database credentials, and internal host details are not part of the Runner contract and must not be added to the execution context.

## Compatibility requirements

This package is currently a private `0.0.0` workspace package. Schemas, queue names, and error semantics are cross-process protocols. Changes must update the Control Plane, Gateway, Worker, Runner, fixtures, and tests together, with coordinated deployment of all producers and consumers. Do not copy independent versions of these structures into individual services.

## Development commands

```bash
pnpm --filter @open-agent-tools/mcp-contracts build
pnpm --filter @open-agent-tools/mcp-contracts test
pnpm --filter @open-agent-tools/mcp-contracts typecheck
pnpm --filter @open-agent-tools/mcp-contracts lint
```
