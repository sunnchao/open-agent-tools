import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory.ts";
import { createMemoryPiTools } from "./memoryPi.ts";

interface ToolSchema {
  required?: string[];
  properties?: Record<string, { enum?: string[] }>;
}

function toolsByName(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

async function executeJson(
  tools: Map<string, ToolDefinition>,
  name: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  assert.ok(tool, `缺少工具 ${name}`);
  const result = await tool.execute(
    "test-call",
    params as never,
    undefined,
    undefined,
    {} as never,
  );
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text && text.type === "text");
  return JSON.parse(text.text) as Record<string, unknown>;
}

test("五个 memory Pi 工具暴露稳定的 TypeBox schema", () => {
  const tools = createMemoryPiTools({
    store: {} as MemoryStore,
    currentSessionId: () => undefined,
  });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["memory_search", "memory_propose", "memory_daily_append", "memory_list", "memory_read"],
  );

  const schemas = new Map(tools.map((tool) => [tool.name, tool.parameters as ToolSchema]));
  assert.deepEqual(schemas.get("memory_search")?.required, ["query"]);
  assert.deepEqual(schemas.get("memory_propose")?.required, [
    "slug",
    "scope",
    "type",
    "description",
    "headline",
    "body",
  ]);
  assert.deepEqual(schemas.get("memory_daily_append")?.required, ["bullet"]);
  assert.deepEqual(schemas.get("memory_list")?.required, undefined);
  assert.deepEqual(schemas.get("memory_read")?.required, ["slug"]);
  assert.deepEqual(schemas.get("memory_propose")?.properties?.scope?.enum, ["global", "project"]);
  assert.deepEqual(schemas.get("memory_propose")?.properties?.type?.enum, [
    "user",
    "feedback",
    "project",
    "reference",
  ]);
});

test("memory Pi 工具保持提议审核和读取契约", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-pi-"));
  const store = new MemoryStore({
    cwd: join(root, "project"),
    globalRoot: join(root, "global"),
    projectRoot: join(root, "project-memory"),
  });
  store.open();

  try {
    const tools = toolsByName(
      createMemoryPiTools({
        store,
        currentSessionId: () => "session-1",
        modelName: "test-model",
      }),
    );
    const proposed = await executeJson(tools, "memory_propose", {
      slug: "typescript-rule",
      scope: "project",
      type: "project",
      description: "项目使用 TypeScript",
      headline: "TypeScript 约定",
      body: "新增代码使用 TypeScript strict 模式。",
      confidence: "high",
    });
    assert.equal(proposed.proposed, true);
    assert.equal(proposed.unreviewed, true);
    assert.equal(store.read("typescript-rule", "project")?.meta.source.conversationId, "session-1");
    assert.deepEqual(
      (await executeJson(tools, "memory_search", { query: "TypeScript" })).matches,
      [],
    );
    assert.deepEqual((await executeJson(tools, "memory_list", {})).entries, []);
    assert.match(
      String((await executeJson(tools, "memory_read", { slug: "typescript-rule" })).error),
      /未找到已审核记忆/,
    );

    store.accept("typescript-rule", "project");
    const searched = (await executeJson(tools, "memory_search", { query: "TypeScript" }))
      .matches as Array<{ slug: string }>;
    assert.equal(searched[0]?.slug, "typescript-rule");
    const listed = (await executeJson(tools, "memory_list", { scope: "project" }))
      .entries as Array<{
      slug: string;
    }>;
    assert.equal(listed[0]?.slug, "typescript-rule");
    const read = await executeJson(tools, "memory_read", {
      slug: "typescript-rule",
      scope: "project",
    });
    assert.equal(read.body, "新增代码使用 TypeScript strict 模式。");

    const daily = await executeJson(tools, "memory_daily_append", {
      bullet: "完成 Pi Agent 记忆工具迁移",
      scope: "project",
    });
    assert.equal(daily.proposed, true);
    assert.equal(daily.unreviewed, true);
    assert.match(String(daily.slug), /^daily-\d{4}-\d{2}-\d{2}-proposal-/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
