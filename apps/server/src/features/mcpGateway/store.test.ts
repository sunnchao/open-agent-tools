import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb } from "../../platform/db.js";
import {
  clearMcpGatewayConfig,
  getMcpGatewayConfig,
  getMcpGatewayCredentials,
  saveMcpGatewayConfig,
} from "./store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-gateway-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
  delete process.env.MCP_GATEWAY_URL;
  delete process.env.MCP_GATEWAY_API_KEY;
});

afterEach(() => {
  closeDb();
  delete process.env.SQLITE_PATH;
  delete process.env.CONFIG_SECRETS_ENCRYPTION_KEY;
  delete process.env.MCP_GATEWAY_URL;
  delete process.env.MCP_GATEWAY_API_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP gateway config", () => {
  it("falls back to environment variables until a database config is saved", () => {
    process.env.MCP_GATEWAY_URL = "http://gateway.internal:4100/";
    process.env.MCP_GATEWAY_API_KEY = "mcp.env.secret";

    assert.equal(getMcpGatewayConfig().source, "environment");
    assert.equal(getMcpGatewayCredentials().gatewayUrl, "http://gateway.internal:4100");
    assert.equal(getMcpGatewayCredentials().gatewayApiKey, "mcp.env.secret");
    assert.equal(JSON.stringify(getMcpGatewayConfig()).includes("mcp.env.secret"), false);
  });

  it("stores the key encrypted and prefers it over environment variables", () => {
    process.env.MCP_GATEWAY_API_KEY = "mcp.env.secret";
    const saved = saveMcpGatewayConfig({
      gatewayUrl: "https://gateway.example.com/",
      apiKey: "mcp.db.secret",
    });

    assert.equal(saved.source, "database");
    assert.equal(saved.gatewayUrl, "https://gateway.example.com");
    assert.equal(saved.configured, true);
    assert.equal(saved.apiKeyMasked?.includes("mcp.db.secret"), false);
    assert.equal(getMcpGatewayCredentials().gatewayApiKey, "mcp.db.secret");
  });

  it("keeps the stored key when only the URL changes", () => {
    saveMcpGatewayConfig({
      gatewayUrl: "http://localhost:4100",
      apiKey: "mcp.keep.secret",
    });
    saveMcpGatewayConfig({ gatewayUrl: "http://localhost:4101" });

    assert.equal(getMcpGatewayCredentials().gatewayUrl, "http://localhost:4101");
    assert.equal(getMcpGatewayCredentials().gatewayApiKey, "mcp.keep.secret");
  });

  it("returns to the environment fallback after the saved config is cleared", () => {
    process.env.MCP_GATEWAY_API_KEY = "mcp.env.secret";
    saveMcpGatewayConfig({ gatewayUrl: "http://localhost:4100", apiKey: "mcp.db.secret" });
    const cleared = clearMcpGatewayConfig();

    assert.equal(cleared.source, "environment");
    assert.equal(getMcpGatewayCredentials().gatewayApiKey, "mcp.env.secret");
  });

  it("rejects an empty key and a non-HTTP URL", () => {
    assert.throws(
      () => saveMcpGatewayConfig({ gatewayUrl: "http://localhost:4100" }),
      /apiKey is required/,
    );
    assert.throws(
      () => saveMcpGatewayConfig({ gatewayUrl: "ftp://localhost", apiKey: "mcp.secret" }),
      /http or https/,
    );
  });
});
