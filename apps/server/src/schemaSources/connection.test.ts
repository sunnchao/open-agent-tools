import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSchemaSourceConnectionString, schemaSourceConnectionMetadata } from "./connection.js";

describe("schema source connection fields", () => {
  const fields = {
    host: "db.internal",
    username: "readonly",
    password: "secret",
    databaseName: "analytics",
  };

  it("uses the connector's default port", () => {
    assert.equal(
      buildSchemaSourceConnectionString(fields, "mysql"),
      "mysql://readonly:secret@db.internal:3306/analytics",
    );
    assert.equal(
      buildSchemaSourceConnectionString(fields, "postgresql"),
      "postgresql://readonly:secret@db.internal:5432/analytics",
    );
  });

  it("encodes special characters in credentials and database names exactly once", () => {
    const input = {
      ...fields,
      username: "report@team",
      password: "p@ss:/?#%中文",
      databaseName: "销售/季度 #1%",
    };
    const url = new URL(buildSchemaSourceConnectionString(input, "postgresql"));
    assert.equal(decodeURIComponent(url.username), input.username);
    assert.equal(decodeURIComponent(url.password), input.password);
    assert.equal(decodeURIComponent(url.pathname.slice(1)), input.databaseName);
    assert.deepEqual(schemaSourceConnectionMetadata(url.toString()), {
      host: input.host,
      port: 5432,
      username: input.username,
      databaseName: input.databaseName,
    });
  });

  it("supports IPv6 hosts with and without brackets", () => {
    for (const host of ["2001:db8::1", "[2001:db8::1]"]) {
      const url = new URL(
        buildSchemaSourceConnectionString({ ...fields, host, port: 5433 }, "postgresql"),
      );
      assert.equal(url.hostname, "[2001:db8::1]");
      assert.equal(url.port, "5433");
      assert.equal(schemaSourceConnectionMetadata(url.toString()).host, "2001:db8::1");
    }
  });

  it("keeps the existing password and URL options when editing other fields", () => {
    const current = "postgresql://old:p%40ss%25@old.internal:5433/old?sslmode=require";
    const updated = new URL(
      buildSchemaSourceConnectionString(
        { host: "new.internal", username: "new", password: "", databaseName: "new_db" },
        "postgresql",
        current,
      ),
    );
    assert.equal(updated.hostname, "new.internal");
    assert.equal(updated.port, "5433");
    assert.equal(updated.username, "new");
    assert.equal(decodeURIComponent(updated.password), "p@ss%");
    assert.equal(updated.pathname, "/new_db");
    assert.equal(updated.searchParams.get("sslmode"), "require");
  });

  it("replaces a password including leading and trailing spaces", () => {
    const updated = new URL(
      buildSchemaSourceConnectionString(
        { password: " new password " },
        "mysql",
        "mysql://user:old@db.internal/analytics",
      ),
    );
    assert.equal(decodeURIComponent(updated.password), " new password ");
  });

  it("allows creating a source without a password", () => {
    const url = new URL(buildSchemaSourceConnectionString({ ...fields, password: "" }, "mysql"));
    assert.equal(url.password, "");
  });

  it("preserves legacy URL input and metadata-only updates", () => {
    const current = "postgres://user:secret@db.internal/db?sslmode=require";
    assert.equal(
      buildSchemaSourceConnectionString({ connectionString: ` ${current} ` }, "postgresql"),
      current,
    );
    assert.equal(buildSchemaSourceConnectionString({}, "postgresql", current), current);
  });

  it("keeps legacy metadata readable when a URL contains literal percent signs", () => {
    assert.deepEqual(schemaSourceConnectionMetadata("mysql://reader%:secret@db.internal/db%name"), {
      host: "db.internal",
      port: 3306,
      username: "reader%",
      databaseName: "db%name",
    });
  });

  it("rejects invalid ports and host strings before connecting", () => {
    for (const port of [
      0,
      -1,
      65536,
      1.5,
      NaN,
      "3306" as unknown as number,
      null as unknown as number,
    ]) {
      assert.throws(() => buildSchemaSourceConnectionString({ ...fields, port }, "mysql"), /端口/);
    }
    for (const host of ["", "mysql://db.internal", "db.internal:3306", "db/internal", "a@db"]) {
      assert.throws(
        () => buildSchemaSourceConnectionString({ ...fields, host }, "mysql"),
        /主机名/,
      );
    }
    assert.throws(
      () => buildSchemaSourceConnectionString({ ...fields, username: "" }, "mysql"),
      /账户/,
    );
    assert.throws(
      () => buildSchemaSourceConnectionString({ ...fields, databaseName: "" }, "mysql"),
      /数据库名称/,
    );
  });
});
