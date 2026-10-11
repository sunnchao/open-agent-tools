import assert from "node:assert/strict";
import test from "node:test";
import { handlers } from "../src/index.js";
import { formatSearchResult, normalizeSearchArgs, searchWeb } from "../src/search.js";

test("normalizes the documented Tavily request defaults", () => {
  assert.deepEqual(normalizeSearchArgs({ query: " latest AI agent news " }), {
    query: "latest AI agent news",
    topic: "general",
    search_depth: "basic",
    include_answer: true,
    max_results: 5,
  });
});

test("rejects invalid search arguments before calling the network", () => {
  assert.throws(() => normalizeSearchArgs({ query: " " }), /query must be 1-400 characters/);
  assert.throws(() => normalizeSearchArgs({ query: "ai", max_results: 11 }), /max_results/);
});

test("posts the curl-equivalent request and returns sources", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({
        answer: "Agents are shipping.",
        results: [{ title: "Example", url: "https://example.com", content: "Details", score: 0.9 }],
      }),
    };
  };

  const result = await searchWeb(
    { query: "latest AI agent news", max_results: 1 },
    {
      fetch: fetchImpl,
      config: { apiKey: "th-test", endpoint: "https://search.example/api" },
    },
  );

  assert.equal(calls[0].url, "https://search.example/api");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer th-test");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    query: "latest AI agent news",
    topic: "general",
    search_depth: "basic",
    include_answer: true,
    max_results: 1,
  });
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Agents are shipping/);
  assert.equal(result.structuredContent.results[0].url, "https://example.com");
});

test("reports a missing API key without throwing from the managed handler", async () => {
  const previous = process.env.TAVILY_API_KEY;
  delete process.env.TAVILY_API_KEY;
  try {
    const result = await handlers.webSearch({ query: "ai" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /TAVILY_API_KEY/);
  } finally {
    if (previous === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previous;
  }
});

test("formats an empty provider response", () => {
  const result = formatSearchResult({});
  assert.match(result.content[0].text, /No source results/);
  assert.deepEqual(result.structuredContent.results, []);
});
