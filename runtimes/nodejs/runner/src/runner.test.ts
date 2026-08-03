import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runToolInvocation, type RunnerErrorCode } from "./runner.js";

const baseManifest = {
  schemaVersion: 1,
  runtime: { name: "nodejs", version: "20" },
  entry: "src/index.js",
  tools: [
    {
      name: "echo",
      handler: "echoHandler",
      inputSchema: { type: "object", additionalProperties: true },
    },
  ],
  prompts: [],
  limits: {
    timeoutMs: 30_000,
    memoryMb: 256,
    cpuMillis: 1_000,
    network: "none",
  },
};

const input = {
  requestId: "req_123",
  toolName: "echo",
  arguments: { value: "hello" },
  context: {
    serviceId: "svc_123",
    versionId: "ver_3",
    clientId: "client_8",
    deadlineAt: "2026-07-31T12:00:30.000Z",
  },
};

interface InvocationFixture {
  directory: string;
  packageRoot: string;
  inputPath: string;
  outputPath: string;
}

async function createFixture(
  entrySource: string,
  inputValue: unknown = input,
): Promise<InvocationFixture> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-node-runner-"));
  const packageRoot = join(directory, "package");
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await writeFile(join(packageRoot, "mcp.json"), JSON.stringify(baseManifest));
  await writeFile(join(packageRoot, "src/index.js"), entrySource);

  const inputPath = join(directory, "input.json");
  const outputPath = join(directory, "output.json");
  await writeFile(inputPath, JSON.stringify(inputValue));
  return { directory, packageRoot, inputPath, outputPath };
}

async function invoke(
  entrySource: string,
  options: { inputValue?: unknown; maxOutputBytes?: number } = {},
): Promise<Record<string, unknown>> {
  const fixture = await createFixture(entrySource, options.inputValue);
  try {
    await runToolInvocation({
      packageRoot: fixture.packageRoot,
      inputPath: fixture.inputPath,
      outputPath: fixture.outputPath,
      maxOutputBytes: options.maxOutputBytes,
    });
    return JSON.parse(await readFile(fixture.outputPath, "utf8")) as Record<string, unknown>;
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

function runnerErrorCode(result: Record<string, unknown>): RunnerErrorCode | undefined {
  const metadata = result._meta as Record<string, unknown> | undefined;
  const platformError = metadata?.["open-agent-tools/error"] as Record<string, unknown> | undefined;
  return platformError?.code as RunnerErrorCode | undefined;
}

function runnerErrorMetadata(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata = result._meta as Record<string, unknown> | undefined;
  return metadata?.["open-agent-tools/error"] as Record<string, unknown> | undefined;
}

test("RUN-001 invokes the configured handler with arguments and minimal context", async () => {
  const result = await invoke(`
    export const handlers = {
      async echoHandler(args, context) {
        return {
          content: [{ type: "text", text: args.value }],
          structuredContent: { args, context },
        };
      },
    };
  `);

  assert.equal(result.isError, false);
  assert.deepEqual(result.content, [{ type: "text", text: "hello" }]);
  assert.deepEqual(result.structuredContent, {
    args: input.arguments,
    context: { requestId: input.requestId, ...input.context },
  });
});

test("RUN-005 returns safe errors for a missing Tool or handler", async () => {
  const missingTool = await invoke("export const handlers = {};", {
    inputValue: { ...input, toolName: "unknown" },
  });
  const missingHandler = await invoke("export const handlers = {};");

  assert.equal(runnerErrorCode(missingTool), "TOOL_NOT_FOUND");
  assert.equal(runnerErrorCode(missingHandler), "HANDLER_NOT_FOUND");
  assert.equal(missingTool.isError, true);
  assert.equal(missingHandler.isError, true);
});

test("RUN-005 does not leak handler exception details", async () => {
  const result = await invoke(`
    export const handlers = {
      echoHandler() {
        throw new Error("secret-token at /private/package/src/index.js");
      },
    };
  `);
  const serialized = JSON.stringify(result);

  assert.equal(runnerErrorCode(result), "HANDLER_FAILED");
  assert.equal(runnerErrorMetadata(result)?.requestId, input.requestId);
  assert.equal(result.isError, true);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("/private/package"), false);
});

test("RUN-005 rejects missing content, circular values, functions, and class instances", async () => {
  const invalidHandlers = [
    "return { structuredContent: {} };",
    "const result = { content: [] }; result.self = result; return result;",
    'return { content: [{ type: "text", text: () => "bad" }] };',
    "return new (class ToolResult { constructor() { this.content = []; } })();",
    'return new Proxy({ content: [] }, { ownKeys() { throw new Error("trap"); } });',
  ];

  for (const handlerBody of invalidHandlers) {
    const result = await invoke(`
      export const handlers = {
        echoHandler() { ${handlerBody} },
      };
    `);
    assert.equal(runnerErrorCode(result), "INVALID_RESULT");
    assert.equal(result.isError, true);
  }
});

test("RUN-004 replaces oversized output with a bounded error result", async () => {
  const result = await invoke(
    `export const handlers = {
      echoHandler() {
        return { content: [{ type: "text", text: "x".repeat(10_000) }] };
      },
    };`,
    { maxOutputBytes: 512 },
  );

  assert.equal(runnerErrorCode(result), "OUTPUT_LIMIT");
  assert.equal(result.isError, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512);
});

test("RUN-005 returns a stable error for malformed input", async () => {
  const result = await invoke("export const handlers = {};", {
    inputValue: { ...input, context: { ...input.context, bearerToken: "secret" } },
  });

  assert.equal(runnerErrorCode(result), "INVALID_INPUT");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
