import assert from "node:assert/strict";
import { after, before, it, mock } from "node:test";
import { closeDb, openDb } from "./db.js";
import { loadResourceCatalog, normalizeResourceBindings } from "./resources.js";
import { createSchemaSource } from "./schemaSources/store.js";

const previousEnv = {
  CONFIG_SECRETS_ENCRYPTION_KEY: process.env.CONFIG_SECRETS_ENCRYPTION_KEY,
  PROVIDER_KEYS_ENCRYPTION_KEY: process.env.PROVIDER_KEYS_ENCRYPTION_KEY,
  SCHEMA_SOURCE_URL: process.env.SCHEMA_SOURCE_URL,
  REPORT_DATABASE_URL: process.env.REPORT_DATABASE_URL,
  MCP_GATEWAY_API_KEY: process.env.MCP_GATEWAY_API_KEY,
};
let enabledSourceId: string;
let disabledSourceId: string;

before(() => {
  openDb(":memory:");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  delete process.env.PROVIDER_KEYS_ENCRYPTION_KEY;
  delete process.env.SCHEMA_SOURCE_URL;
  delete process.env.REPORT_DATABASE_URL;
  delete process.env.MCP_GATEWAY_API_KEY;
  mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ sources: [] })));
  enabledSourceId = createSchemaSource({
    name: "运营库",
    connectionString: "mysql://readonly:private-password@db.internal/ops",
  }).id;
  disabledSourceId = createSchemaSource({
    name: "已停用",
    connectionString: "postgresql://readonly:private-password@db.internal/ops",
    enabled: false,
  }).id;
});

after(() => {
  closeDb();
  mock.restoreAll();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it("exposes only enabled SQL source identities without database credentials", async () => {
  const catalog = await loadResourceCatalog();
  assert.equal(catalog.sql?.sources.length, 1);
  assert.equal(catalog.sql?.sources[0]?.name, "运营库");
  assert.equal(catalog.sql?.sources[0]?.isDefault, true);
  assert.deepEqual(Object.keys(catalog.sql!.sources[0]!).sort(), [
    "connector",
    "id",
    "isDefault",
    "name",
  ]);
  assert.equal(JSON.stringify(catalog).includes("private-password"), false);
  assert.equal(JSON.stringify(catalog).includes("db.internal"), false);
});

it("keeps other workflow resources usable when SQL source configuration cannot be read", async () => {
  delete process.env.CONFIG_SECRETS_ENCRYPTION_KEY;
  const catalog = await loadResourceCatalog();
  assert.deepEqual(catalog.sql?.sources, []);
  assert.match(catalog.sql?.error ?? "", /CONFIG_ERROR/);
  assert.deepEqual(catalog.rag.sources, []);
  assert.deepEqual(catalog.mcp.services, []);
});

it("normalizes SQL bindings and rejects unknown or disabled sources", () => {
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  assert.deepEqual(
    normalizeResourceBindings({ sqlSources: [` ${enabledSourceId} `, enabledSourceId] }).sqlSources,
    [enabledSourceId],
  );
  for (const sqlSources of [[disabledSourceId], ["missing"], [""], Array(21).fill(enabledSourceId)]) {
    assert.throws(() => normalizeResourceBindings({ sqlSources }), /sqlSources/);
  }
  for (const sqlSources of ["source", {}, [null]]) {
    assert.throws(
      () => normalizeResourceBindings({ sqlSources } as never),
      /sqlSources/,
    );
  }
  assert.deepEqual(normalizeResourceBindings().sqlSources, []);
});
