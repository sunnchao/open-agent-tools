import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../../app.js";
import { closeDb } from "../db.js";
import { recordUsageEvent } from "./events.js";
import type { UsageSummary } from "./events.js";

let server: Server;
let origin: string;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "usage-api-test-"));
  process.env.SQLITE_PATH = join(dir, "test.sqlite");
  delete process.env.STUDIO_API_TOKEN;
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

describe("usage API", () => {
  it("summarizes recorded chat and tool usage", async () => {
    recordUsageEvent({
      kind: "chat",
      sessionId: "s1",
      providerId: "default",
      model: "gpt-4o-mini",
      inputTokens: 300,
      outputTokens: 120,
      toolCalls: 1,
      durationMs: 2100,
    });
    recordUsageEvent({
      kind: "tool",
      toolKind: "mcp",
      toolName: "crm/get_contact",
      durationMs: 90,
      status: "ok",
    });

    const response = await fetch(`${origin}/api/admin/usage?days=1`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { usage: UsageSummary };
    assert.equal(body.usage.totals.chatTurns, 1);
    assert.equal(body.usage.totals.toolCalls, 1);
    assert.equal(body.usage.totals.inputTokens, 300);
    assert.equal(body.usage.totals.outputTokens, 120);
    assert.equal(body.usage.totals.totalTokens, 420);
    assert.equal(body.usage.byModel[0]?.model, "gpt-4o-mini");
    assert.equal(body.usage.byTool[0]?.toolName, "crm/get_contact");
    assert.equal(body.usage.daily.length, 1);
  });

  it("returns recent events and rejects an inverted time window", async () => {
    const events = await fetch(`${origin}/api/admin/usage/events?limit=1`);
    assert.equal(events.status, 200);
    const body = (await events.json()) as { events: Array<{ kind: string }> };
    assert.equal(body.events.length, 1);

    const inverted = await fetch(
      `${origin}/api/admin/usage?from=2026-10-20T00:00:00Z&to=2026-10-19T00:00:00Z`,
    );
    assert.equal(inverted.status, 400);
  });
});
