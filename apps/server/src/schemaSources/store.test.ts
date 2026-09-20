import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb } from "../db.js";
import {
  createSchemaSource,
  deleteSchemaSource,
  duplicateSchemaSource,
  getDefaultSchemaSource,
  getSchemaSource,
  listSchemaSources,
  setDefaultSchemaSource,
  updateSchemaSourceSyncState,
  updateSchemaSource,
} from "./store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "schema-source-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  delete process.env.SCHEMA_SOURCE_URL;
  delete process.env.SCHEMA_SOURCE_CONNECTOR;
  delete process.env.SCHEMA_SOURCE_SCHEMA;
  delete process.env.REPORT_DATABASE_URL;
});

afterEach(() => {
  closeDb();
  delete process.env.SQLITE_PATH;
  delete process.env.CONFIG_SECRETS_ENCRYPTION_KEY;
  delete process.env.SCHEMA_SOURCE_URL;
  delete process.env.SCHEMA_SOURCE_CONNECTOR;
  delete process.env.SCHEMA_SOURCE_SCHEMA;
  delete process.env.REPORT_DATABASE_URL;
  rmSync(dir, { recursive: true, force: true });
});

describe("schema source store", () => {
  it("stores multiple encrypted sources without exposing credentials", () => {
    const first = createSchemaSource({
      name: "运营库",
      connectionString: "mysql://readonly:secret@db.internal:3306/ops",
      semanticProfile: "oneapi",
      tableFilter: ["users", "logs*"],
    });
    const second = createSchemaSource({
      name: "财务库",
      connectionString: "mysql://finance:secret@finance.internal/finance",
    });
    assert.equal(first.isDefault, true);
    assert.equal(second.isDefault, false);
    assert.equal(first.endpoint, "db.internal:3306/ops");
    assert.equal("connectionString" in first, false);
    assert.equal(getSchemaSource(first.id)?.connectionString.includes("secret"), true);
    assert.equal(listSchemaSources({ includeDisabled: true }).length, 2);
  });

  it("stores PostgreSQL sources and keeps the schema scope", () => {
    const source = createSchemaSource({
      name: "分析库",
      connector: "postgresql",
      connectionString: "postgresql://readonly:secret@pg.internal:5432/analytics",
      schemaName: "reporting",
    });
    assert.equal(source.connector, "postgresql");
    assert.equal(source.endpoint, "pg.internal:5432/analytics#reporting");
    assert.equal(source.schemaName, "reporting");
    assert.equal(
      getSchemaSource(source.id)?.connectionString,
      "postgresql://readonly:secret@pg.internal:5432/analytics",
    );
  });

  it("rejects connector and connection protocol mismatches", () => {
    assert.throws(
      () =>
        createSchemaSource({
          name: "错误配置",
          connector: "postgresql",
          connectionString: "mysql://u:p@db/report",
        }),
      /does not match postgresql/,
    );
  });

  it("updates, switches default, and protects the active default", () => {
    const first = createSchemaSource({ name: "A", connectionString: "mysql://u:p@a/db" });
    const second = createSchemaSource({ name: "B", connectionString: "mysql://u:p@b/db" });
    assert.equal(setDefaultSchemaSource(second.id)?.isDefault, true);
    assert.throws(() => updateSchemaSource(second.id, { enabled: false }), /default/);
    assert.equal(deleteSchemaSource(second.id), "default");
    assert.equal(deleteSchemaSource(first.id), "deleted");
  });

  it("exposes the legacy environment source without persisting its secret", () => {
    process.env.SCHEMA_SOURCE_URL = "mysql://u:p@env.internal/report";
    const source = getDefaultSchemaSource();
    assert.equal(source?.id, "environment-report");
    assert.equal(source?.managedByEnv, true);
    const listed = listSchemaSources()[0];
    assert.equal(listed?.endpoint, "env.internal/report");
    assert.equal("connectionString" in listed!, false);
    assert.equal(deleteSchemaSource("environment-report"), "managed");
  });

  it("infers a PostgreSQL environment source and its schema", () => {
    process.env.SCHEMA_SOURCE_URL = "postgresql://u:p@pg.internal/analytics";
    process.env.SCHEMA_SOURCE_SCHEMA = "reporting";
    const source = getDefaultSchemaSource();
    assert.equal(source?.connector, "postgresql");
    assert.equal(source?.schemaName, "reporting");
    assert.equal(source?.endpoint, "pg.internal/analytics#reporting");
  });

  it("tracks schema synchronization state", () => {
    const source = createSchemaSource({ name: "A", connectionString: "mysql://u:p@a/db" });
    updateSchemaSourceSyncState(source.id, {
      status: "ready",
      lastSyncedAt: "2026-09-18T00:00:00.000Z",
      tableCount: 12,
      relationCount: 8,
      error: null,
    });
    const updated = listSchemaSources().find((item) => item.id === source.id);
    assert.equal(updated?.syncStatus, "ready");
    assert.equal(updated?.tableCount, 12);
    assert.equal(updated?.relationCount, 8);
  });

  it("duplicates a source as a disabled non-default draft", () => {
    const source = createSchemaSource({
      name: "Production",
      connectionString: "mysql://u:p@db/prod",
      tableFilter: ["orders*"],
    });
    const duplicate = duplicateSchemaSource(source.id);
    assert.equal(duplicate?.name, "Production 副本");
    assert.equal(duplicate?.enabled, false);
    assert.equal(duplicate?.isDefault, false);
    assert.deepEqual(duplicate?.tableFilter, ["orders*"]);
    assert.equal(getSchemaSource(duplicate!.id)?.connectionString, "mysql://u:p@db/prod");
  });
});
