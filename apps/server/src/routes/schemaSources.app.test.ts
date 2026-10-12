import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../app.js";
import { closeDb } from "../db.js";
import { getSchemaSource } from "../schemaSources/store.js";

let server: Server;
let origin: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "schema-source-api-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.CONFIG_SECRETS_ENCRYPTION_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  delete process.env.SCHEMA_SOURCE_URL;
  delete process.env.REPORT_DATABASE_URL;
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.close();
  await once(server, "close");
  closeDb();
  delete process.env.SQLITE_PATH;
  delete process.env.CONFIG_SECRETS_ENCRYPTION_KEY;
  rmSync(dir, { recursive: true, force: true });
});

describe("schema source API", () => {
  let sourceId = "";

  it("creates and lists sources without returning connection strings", async () => {
    const createdResponse = await fetch(`${origin}/api/admin/schema-sources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "运营库",
        connectionString: "mysql://readonly:secret@db.internal:3306/ops",
        tableFilter: ["users", "logs"],
        semanticProfile: "oneapi",
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as {
      source: { id: string; endpoint: string; isDefault: boolean };
    };
    sourceId = created.source.id;
    assert.equal(created.source.endpoint, "db.internal:3306/ops");
    assert.equal(created.source.isDefault, true);

    const listed = (await fetch(`${origin}/api/admin/schema-sources`).then((response) =>
      response.json(),
    )) as { sources: Array<Record<string, unknown>> };
    assert.equal(listed.sources.length, 1);
    assert.equal("connectionString" in listed.sources[0]!, false);
    assert.equal(JSON.stringify(listed).includes("secret"), false);

    const publicList = (await fetch(`${origin}/api/schema-sources`).then((response) =>
      response.json(),
    )) as { sources: Array<Record<string, unknown>> };
    assert.equal("endpoint" in publicList.sources[0]!, false);
    assert.equal("tableFilter" in publicList.sources[0]!, false);
  });

  it("creates PostgreSQL sources with a schema scope", async () => {
    const response = await fetch(`${origin}/api/admin/schema-sources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "分析库",
        connector: "postgresql",
        connectionString: "postgresql://readonly:secret@pg.internal:5432/analytics",
        schemaName: "reporting",
        enabled: false,
      }),
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      source: { connector: string; endpoint: string; schemaName: string };
    };
    assert.equal(body.source.connector, "postgresql");
    assert.equal(body.source.endpoint, "pg.internal:5432/analytics#reporting");
    assert.equal(body.source.schemaName, "reporting");
  });

  it("creates and edits individual fields while retaining the stored password", async () => {
    const response = await fetch(`${origin}/api/admin/schema-sources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Fields",
        connector: "mysql",
        host: "db.internal",
        port: 3307,
        username: "reader",
        password: "private@password",
        databaseName: "ops",
      }),
    });
    assert.equal(response.status, 201);
    const created = (await response.json()) as { source: Record<string, unknown> };
    const id = created.source.id as string;
    assert.equal(created.source.host, "db.internal");
    assert.equal(created.source.port, 3307);
    assert.equal(created.source.username, "reader");
    assert.equal("password" in created.source, false);
    assert.equal("connectionString" in created.source, false);
    const editedResponse = await fetch(`${origin}/api/admin/schema-sources/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: "new.internal",
        port: 3308,
        username: "reader2",
        password: "",
        databaseName: "new_ops",
      }),
    });
    assert.equal(editedResponse.status, 200);
    const edited = (await editedResponse.json()) as { source: Record<string, unknown> };
    assert.equal(edited.source.endpoint, "new.internal:3308/new_ops");
    const url = new URL(getSchemaSource(id)!.connectionString);
    assert.equal(decodeURIComponent(url.password), "private@password");
    assert.equal(url.username, "reader2");
    const publicList = (await fetch(`${origin}/api/schema-sources`).then((result) =>
      result.json(),
    )) as { sources: Array<Record<string, unknown>> };
    assert.equal("username" in publicList.sources[0]!, false);
    assert.equal("host" in publicList.sources[0]!, false);
  });

  it("validates the current test draft without saving it", async () => {
    const previous = getSchemaSource(sourceId)!.connectionString;
    const response = await fetch(`${origin}/api/admin/schema-sources/${sourceId}/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: 65536 }),
    });
    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /端口/);
    assert.equal(getSchemaSource(sourceId)!.connectionString, previous);
  });

  it("rejects invalid ports from JSON payloads", async () => {
    for (const port of [0, 65536, "3306"]) {
      const response = await fetch(`${origin}/api/admin/schema-sources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Invalid",
          host: "db.internal",
          port,
          username: "reader",
          databaseName: "ops",
        }),
      });
      assert.equal(response.status, 400);
      assert.match(((await response.json()) as { error: string }).error, /端口/);
    }
  });

  it("protects the default source from deletion", async () => {
    const response = await fetch(
      `${origin}/api/admin/schema-sources/${encodeURIComponent(sourceId)}`,
      { method: "DELETE" },
    );
    assert.equal(response.status, 409);
  });

  it("duplicates a source as a disabled draft that can be deleted", async () => {
    const duplicatedResponse = await fetch(
      `${origin}/api/admin/schema-sources/${encodeURIComponent(sourceId)}/duplicate`,
      { method: "POST" },
    );
    assert.equal(duplicatedResponse.status, 201);
    const duplicated = (await duplicatedResponse.json()) as {
      source: { id: string; enabled: boolean; isDefault: boolean };
    };
    assert.equal(duplicated.source.enabled, false);
    assert.equal(duplicated.source.isDefault, false);
    const removed = await fetch(
      `${origin}/api/admin/schema-sources/${encodeURIComponent(duplicated.source.id)}`,
      { method: "DELETE" },
    );
    assert.equal(removed.status, 204);
  });
});
