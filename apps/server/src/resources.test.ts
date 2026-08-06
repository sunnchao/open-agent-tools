import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResourceBindings, resolveMcpToolsFromCatalog, toolAlias } from "./resources.js";

test("tool aliases are stable and isolate services with the same tool name", () => {
  const first = toolAlias({ serviceSlug: "alpha", toolName: "search" });
  assert.equal(first, toolAlias({ serviceSlug: "alpha", toolName: "search" }));
  assert.notEqual(first, toolAlias({ serviceSlug: "beta", toolName: "search" }));
  assert.match(first, /^mcp_[a-f0-9]{8}_search$/);
});

test("resource bindings are trimmed, bounded, and deduplicated", () => {
  assert.deepEqual(
    normalizeResourceBindings({
      mcpTools: [
        { serviceSlug: " docs ", toolName: " search " },
        { serviceSlug: "docs", toolName: "search" },
      ],
      rag: { sources: [" guide.md ", "guide.md"], topK: 99 },
    }),
    {
      mcpTools: [{ serviceSlug: "docs", toolName: "search" }],
      rag: { sources: ["guide.md"], topK: 20 },
    },
  );
});

test("resource bindings reject invalid entries", () => {
  assert.throws(
    () => normalizeResourceBindings({ mcpTools: [{ serviceSlug: "", toolName: "search" }] }),
    /valid bindings/,
  );
  assert.throws(() => normalizeResourceBindings({ rag: { sources: [""] } }), /valid source names/);
});

test("MCP bindings reject tools that are no longer in the authorized catalog", () => {
  assert.throws(
    () =>
      resolveMcpToolsFromCatalog(
        [{ serviceSlug: "docs", toolName: "removed_tool" }],
        [
          {
            serviceSlug: "docs",
            serviceStatus: "ACTIVE",
            versionStatus: "PUBLISHED",
            tools: [],
          },
        ],
      ),
    /MCP Tool is unavailable/,
  );
});
