import assert from "node:assert/strict";
import test from "node:test";
import {
  RemoteServiceConfigPatchSchema,
  RemoteServiceConfigSchema,
  maskRemoteConfig,
  mergeRemoteConfig,
} from "./remote.js";

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
  assert.equal(
    RemoteServiceConfigSchema.safeParse({ ...validConfig, url: "not-a-url" }).success,
    false,
  );
});

test("rejects empty tokens, out-of-range timeouts and non-string headers", () => {
  assert.equal(RemoteServiceConfigSchema.safeParse({ ...validConfig, token: "" }).success, false);
  assert.equal(
    RemoteServiceConfigSchema.safeParse({ ...validConfig, token: "t".repeat(2_049) }).success,
    false,
  );
  assert.equal(
    RemoteServiceConfigSchema.safeParse({ ...validConfig, timeoutMs: 0 }).success,
    false,
  );
  assert.equal(
    RemoteServiceConfigSchema.safeParse({ ...validConfig, timeoutMs: 120_001 }).success,
    false,
  );
  assert.equal(
    RemoteServiceConfigSchema.safeParse({ ...validConfig, timeoutMs: 1.5 }).success,
    false,
  );
  assert.equal(
    RemoteServiceConfigSchema.safeParse({ ...validConfig, headers: { "X-Custom": 1 } }).success,
    false,
  );
});

test("rejects non-http URLs and embedded credentials", () => {
  assert.equal(
    RemoteServiceConfigSchema.safeParse({ ...validConfig, url: "ftp://mcp.example.com/x" }).success,
    false,
  );
  assert.equal(
    RemoteServiceConfigSchema.safeParse({
      ...validConfig,
      url: "https://user:pw@mcp.example.com/x",
    }).success,
    false,
  );
});

test("maskRemoteConfig hides the token but reports its presence", () => {
  assert.deepEqual(maskRemoteConfig({ ...validConfig, timeoutMs: 30_000 }), {
    transport: "streamable-http",
    url: "https://mcp.example.com/mcp",
    timeoutMs: 30_000,
    hasToken: false,
  });
  const masked = maskRemoteConfig({ ...validConfig, timeoutMs: 5_000, token: "abc" });
  assert.equal(masked.hasToken, true);
  assert.ok(!("token" in masked));
});

test("mergeRemoteConfig keeps/clears/overwrites the token", () => {
  const current = { ...validConfig, timeoutMs: 30_000, token: "old" };
  assert.equal(mergeRemoteConfig(current, {}).token, "old");
  assert.equal(mergeRemoteConfig(current, { token: null }).token, "old");
  assert.equal(mergeRemoteConfig(current, { url: "https://mcp.example.com/v2" }).token, "old");
  assert.equal(mergeRemoteConfig(current, { token: "" }).token, undefined);
  assert.equal(mergeRemoteConfig(current, { token: "new" }).token, "new");
  assert.equal(RemoteServiceConfigPatchSchema.safeParse({ token: "", extra: 1 }).success, false);
});
