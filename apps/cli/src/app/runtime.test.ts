import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

it("只装配 package time、CLI memory 与 MCP 自定义工具", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "cli-runtime-"));
  const mcpConfigPath = join(rootDir, "mcp.json");
  const previousMcpConfig = process.env.MCP_CONFIG;
  const previousOpenAiApiKey = process.env.OPENAI_API_KEY;
  let runtime: Awaited<ReturnType<(typeof import("./runtime.ts"))["createRuntime"]>> | undefined;

  try {
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: [] }), "utf8");
    process.env.MCP_CONFIG = mcpConfigPath;
    process.env.OPENAI_API_KEY = "test-api-key";
    const { createRuntime } = await import("./runtime.ts");

    runtime = await createRuntime();
    await runtime.rebuildTools();
    const toolNames = runtime.cli.allTools.map((tool) => tool.name).sort();

    assert.deepEqual(toolNames, [
      "getCurrentTime",
      "memory_daily_append",
      "memory_list",
      "memory_propose",
      "memory_read",
      "memory_search",
    ]);
    assert.equal(toolNames.includes("writeFile"), false);
    assert.equal(toolNames.includes("editFile"), false);
    assert.equal(toolNames.includes("executeCommand"), false);
  } finally {
    await runtime?.cli.mcpCleanup();
    runtime?.rl.close();
    runtime?.memoryStore.close();
    if (previousMcpConfig === undefined) delete process.env.MCP_CONFIG;
    else process.env.MCP_CONFIG = previousMcpConfig;
    if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    await rm(rootDir, { recursive: true, force: true });
  }
});
