import assert from "node:assert/strict";
import test from "node:test";
import { RemoteServiceConfigSchema } from "./remote.js";

const validConfig = {
  transport: "streamable-http",
  url: "https://mcp.example.com/mcp",
  timeoutMs: 30_000,
};

test("accepts a minimal remote service config and applies defaults", () => {
  assert.deepEqual(RemoteServiceConfigSchema.parse(validConfig), validConfig);
  assert.deepEqual(
    RemoteServiceConfigSchema.parse({ transport: "sse", url: "https://mcp.example.com/sse" }),
    {
      transport: "sse",
      url: "https://mcp.example.com/sse",
      timeoutMs: 30_000,
    },
  );
});

test("accepts headers and bounded token", () => {
  const config = {
    ...validConfig,
    headers: { "X-Custom": "value" },
    token: "secret-token",
  };
  assert.deepEqual(RemoteServiceConfigSchema.parse(config), config);
});

test("rejects unknown keys, invalid transports and URLs", () => {
  assert.equal(RemoteServiceConfigSchema.safeParse({ ...validConfig, extra: true }).success, false);
  assert.equal(
    RemoteServiceConfigSchema.safeParse({ ...validConfig, transport: "websocket" }).success,
    false,
  );
  assert.equal(RemoteServiceConfigSchema.safeParse({ ...validConfig, url: "not-a-url" }).success, false);
});

test("rejects empty tokens, out-of-range timeouts and non-string headers", () => {
  assert.equal(RemoteServiceConfigSchema.safeParse({ ...validConfig, token: "" }).success, false);
  assert.equal(
    RemoteServiceConfigSchema.safeParse({ ...validConfig, token: "t".repeat(2_049) }).success,
    false,
  );
  assert.equal(RemoteServiceConfigSchema.safeParse({ ...validConfig, timeoutMs: 0 }).success, false);
  assert.equal(
    RemoteServiceConfigSchema.safeParse({ ...validConfig, timeoutMs: 120_001 }).success,
    false,
  );
  assert.equal(RemoteServiceConfigSchema.safeParse({ ...validConfig, timeoutMs: 1.5 }).success, false);
  assert.equal(
    RemoteServiceConfigSchema.safeParse({ ...validConfig, headers: { "X-Custom": 1 } }).success,
    false,
  );
});
