import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../../../app.js";
import { closeDb } from "../../../platform/db.js";

let server: Server;
let origin: string;
let dir: string;

const CONFIG = { org: { directory: [{ code: "BJ", name: "北京分公司", aliases: ["北京"] }] } };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "caliber-api-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
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
  rmSync(dir, { recursive: true, force: true });
});

async function post(path: string, body: unknown) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("caliber config API", () => {
  let configId = "";

  it("creates the first config as the enabled default", async () => {
    const response = await post("/api/admin/caliber-configs", { name: "默认口径", config: CONFIG });
    assert.equal(response.status, 201);
    const payload = (await response.json()) as {
      config: { id: string; isDefault: boolean; enabled: boolean; config: { org: { directory: unknown[] } } };
    };
    configId = payload.config.id;
    assert.equal(payload.config.isDefault, true);
    assert.equal(payload.config.enabled, true);
    assert.equal(payload.config.config.org.directory.length, 1);
  });

  it("rejects invalid configs with 400", async () => {
    const response = await post("/api/admin/caliber-configs", {
      name: "坏口径",
      config: { org: { directory: [] } },
    });
    assert.equal(response.status, 400);
  });

  it("exposes public metadata without the raw config", async () => {
    const response = await fetch(`${origin}/api/caliber-configs`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { configs: Array<Record<string, unknown>> };
    const entry = payload.configs.find((c) => c.id === configId);
    assert.ok(entry);
    assert.equal(entry.config, undefined);
    assert.equal(entry.isDefault, true);
  });

  it("resolves four-slot utterances against the default config", async () => {
    const response = await post("/api/caliber/resolve", {
      utterance: "北京分公司上个月的差旅报销",
      context: { now: "2026-07-15T00:00:00Z" },
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      configId: string;
      outcome: { ok: boolean; caliber?: { org: { code: string } } };
    };
    assert.equal(payload.configId, configId);
    assert.equal(payload.outcome.ok, true);
    assert.equal(payload.outcome.caliber?.org.code, "BJ");

    const invalid = await post("/api/caliber/resolve", { utterance: "  " });
    assert.equal(invalid.status, 400);

    const missing = await post("/api/caliber/resolve", {
      configId: "does-not-exist",
      utterance: "北京分公司上个月的差旅报销",
    });
    assert.equal(missing.status, 404);
  });

  it("switches the default and blocks deleting the default config", async () => {
    const created = await post("/api/admin/caliber-configs", { name: "备用口径", config: CONFIG });
    const second = ((await created.json()) as { config: { id: string } }).config.id;

    const promoted = await fetch(`${origin}/api/admin/caliber-configs/${second}/default`, { method: "PUT" });
    assert.equal(promoted.status, 200);
    assert.equal(((await promoted.json()) as { config: { isDefault: boolean } }).config.isDefault, true);

    const blocked = await fetch(`${origin}/api/admin/caliber-configs/${second}`, { method: "DELETE" });
    assert.equal(blocked.status, 409);

    const removed = await fetch(`${origin}/api/admin/caliber-configs/${configId}`, { method: "DELETE" });
    assert.equal(removed.status, 204);

    const missingDelete = await fetch(`${origin}/api/admin/caliber-configs/does-not-exist`, { method: "DELETE" });
    assert.equal(missingDelete.status, 404);
  });
});
