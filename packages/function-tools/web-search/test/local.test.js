import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeLocal, loadLocalEnv, parseLocalArgs } from "../scripts/local.mjs";

test("parses a local search command", () => {
  assert.deepEqual(parseLocalArgs(["latest AI", "agent news", "--topic", "news", "--max-results", "1", "--no-answer", "--json"]), {
    query: "latest AI agent news",
    topic: "news",
    max_results: 1,
    include_answer: false,
    json: true,
  });
});

test("loads a local env file without overriding existing values or exposing them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-search-local-"));
  const path = join(dir, ".env.local");
  await writeFile(path, "TAVILY_API_KEY=from-file\nTAVILY_SEARCH_URL=https://search.example\n# comment\n");
  try {
    const env = { TAVILY_API_KEY: "already-set" };
    loadLocalEnv(path, env);
    assert.equal(env.TAVILY_API_KEY, "already-set");
    assert.equal(env.TAVILY_SEARCH_URL, "https://search.example");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("executes the managed handler and returns its result", async () => {
  const calls = [];
  const result = await executeLocal(
    { query: "ai" },
    {
      envPath: join(tmpdir(), "missing.env"),
      search: async (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: "ok" }], isError: false };
      },
    },
  );

  assert.deepEqual(calls, [{ query: "ai" }]);
  assert.equal(result.content[0].text, "ok");
});
