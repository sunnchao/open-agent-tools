import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../app.js";
import { DEFAULT_BRANDING } from "../branding.js";
import { closeDb } from "../db.js";

const TOKEN = "branding-test-token";
let server: Server;
let origin = "";
let dir = "";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "branding-api-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  process.env.STUDIO_API_TOKEN = TOKEN;
  delete process.env.OIDC_ISSUER;
  closeDb();
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
  delete process.env.STUDIO_API_TOKEN;
  rmSync(dir, { recursive: true, force: true });
});

const admin = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

describe("branding API", () => {
  it("serves branding publicly without a token", async () => {
    const response = await fetch(`${origin}/api/branding`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { branding: typeof DEFAULT_BRANDING };
    assert.equal(body.branding.productName, DEFAULT_BRANDING.productName);
  });

  it("requires a token for the admin view", async () => {
    const response = await fetch(`${origin}/api/admin/branding`);
    assert.equal(response.status, 401);
  });

  it("saves a valid configuration and exposes it publicly", async () => {
    const response = await fetch(`${origin}/api/admin/branding`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({
        productName: "私有化助手",
        markText: "私",
        primaryColor: "#0a7f5a",
        partnerCode: "east-1",
      }),
    });
    assert.equal(response.status, 200);
    const saved = (await response.json()) as { branding: typeof DEFAULT_BRANDING };
    assert.equal(saved.branding.productName, "私有化助手");
    assert.equal(saved.branding.primaryColor, "#0a7f5a");

    const publicResponse = await fetch(`${origin}/api/branding`);
    const publicBody = (await publicResponse.json()) as {
      branding: typeof DEFAULT_BRANDING;
    };
    assert.equal(publicBody.branding.partnerCode, "east-1");
    assert.equal(publicResponse.headers.get("cache-control"), "no-store");
  });

  it("rejects invalid input with 400", async () => {
    const response = await fetch(`${origin}/api/admin/branding`, {
      method: "PUT",
      headers: admin,
      body: JSON.stringify({ primaryColor: "not-a-color" }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { errors: string[] };
    assert.ok(body.errors.length > 0);
  });

  it("resets back to defaults", async () => {
    const response = await fetch(`${origin}/api/admin/branding`, {
      method: "DELETE",
      headers: admin,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { branding: typeof DEFAULT_BRANDING };
    assert.deepEqual(body.branding, DEFAULT_BRANDING);
  });
});
