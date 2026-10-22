import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { readServerConfig } from "./config.js";

test("defaults to pgvector and preserves the existing server-relative data paths", () => {
  const config = readServerConfig({ RAG_PG_URL: "postgresql://localhost/knowledge" });
  assert.equal(config.store.kind, "pgvector");
  assert.equal(config.store.postgres?.connectionString, "postgresql://localhost/knowledge");
  assert.equal(config.store.elasticsearch, undefined);
  assert.equal(config.dbPath, resolve(import.meta.dirname, "../rag.db"));
  assert.equal(config.graphDbPath, resolve(import.meta.dirname, "../rag-graph.db"));
  assert.equal(config.host, "127.0.0.1");
});

test("explicit sqlite stays offline even when shared deployment variables contain PG/ES", () => {
  const config = readServerConfig({
    RAG_STORE: "sqlite",
    DATABASE_URL: "postgresql://localhost/knowledge",
    RAG_ES_NODE: "http://localhost:9200",
  });
  assert.equal(config.store.kind, "sqlite");
  assert.equal(config.store.postgres, undefined);
  assert.equal(config.store.elasticsearch, undefined);
});

test("normalizes storage aliases and keeps PG/ES synchronization settings together", () => {
  const config = readServerConfig({
    RAG_STORE: " PG ",
    DATABASE_URL: "postgresql://localhost/knowledge",
    RAG_ES_NODE: "http://localhost:9200",
    RAG_ES_SYNC_MODE: "strict",
    RAG_ES_QUERY_MODE: "strict",
    RAG_ES_MAX_RETRIES: "2",
  });
  assert.equal(config.store.kind, "pgvector");
  assert.equal(config.store.syncMode, "strict");
  assert.equal(config.store.keywordFailureMode, "strict");
  assert.equal(config.store.elasticsearch?.clientOptions?.maxRetries, 2);
  assert.equal(
    readServerConfig({ RAG_STORE: "es", RAG_ES_NODE: "http://localhost:9200" }).store.kind,
    "elasticsearch",
  );
});

test("rejects incomplete or unknown storage configuration before opening resources", () => {
  assert.throws(() => readServerConfig({}), /requires RAG_PG_URL/);
  assert.throws(() => readServerConfig({ RAG_STORE: "es" }), /requires RAG_ES_NODE/);
  assert.throws(() => readServerConfig({ RAG_STORE: "typo" }), /RAG_STORE must be/);
});

test("resolves server capabilities, auth and chunk defaults from the supplied environment", () => {
  const config = readServerConfig({
    RAG_STORE: "sqlite",
    NODE_ENV: "production",
    RAG_RUNTIME_TOKEN: "runtime",
    RAG_ADMIN_TOKEN: "admin",
    RAG_GRAPH_RETRIEVAL: "false",
    RAG_AUTO_EXTRACT: "false",
    RAG_CHUNK_SIZE: "900",
    RAG_SEPARATORS: '["。","\\n"]',
  });
  assert.equal(config.host, "0.0.0.0");
  assert.deepEqual(config.auth, { runtimeToken: "runtime", adminToken: "admin" });
  assert.equal(config.graphRetrieval, false);
  assert.equal(config.autoExtract, false);
  assert.equal(config.chunk.chunkSize, 900);
  assert.deepEqual(config.chunk.separators, ["。", "\n"]);
});
