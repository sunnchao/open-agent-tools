import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  addMessage,
  closeDb,
  createSession,
  ensureSession,
  listSessions,
  listSessionsWithMessages,
  openDb,
  touchSession,
} from "./db.js";
import { createWorkspace } from "./workspace/store.js";

describe("session source and workspace isolation", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "open-agent-tools-session-source-"));
    process.env.SQLITE_PATH = join(dir, "test.sqlite");
    closeDb();
    openDb();
  });

  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SQLITE_PATH;
  });

  it("hides IM sessions from the default web listing", () => {
    createSession({ id: "web-1", title: "Web" });
    createSession({
      id: "im-1",
      title: "IM",
      source: "im",
      actor: "staff_1",
      channelId: "chan_1",
    });

    const webOnly = listSessions();
    assert.deepEqual(
      webOnly.map((session) => session.id),
      ["web-1"],
    );

    const imOnly = listSessions(undefined, { source: "im" });
    assert.deepEqual(
      imOnly.map((session) => session.id),
      ["im-1"],
    );

    const all = listSessions(undefined, { source: "all" });
    assert.equal(all.length, 2);
  });

  it("keeps sessions of different workspaces isolated", () => {
    const wsA = createWorkspace({ name: "A" });
    const wsB = createWorkspace({ name: "B" });
    createSession({ id: "a-1", workspaceId: wsA.id, source: "im" });
    createSession({ id: "b-1", workspaceId: wsB.id, source: "im" });

    assert.deepEqual(
      listSessions(wsA.id, { source: "im" }).map((session) => session.id),
      ["a-1"],
    );
    assert.deepEqual(
      listSessions(wsB.id, { source: "im" }).map((session) => session.id),
      ["b-1"],
    );
    assert.equal(listSessions(wsA.id, { source: "all" }).length, 1);
  });

  it("stores source, actor and channel id on IM sessions", () => {
    ensureSession("im-session", "ws_x", {
      source: "im",
      actor: "staff_9",
      channelId: "chan_9",
    });
    const row = openDb()
      .prepare("SELECT source, actor, channel_id, workspace_id FROM sessions WHERE id = ?")
      .get("im-session") as {
      source: string;
      actor: string;
      channel_id: string;
      workspace_id: string;
    };
    assert.equal(row.source, "im");
    assert.equal(row.actor, "staff_9");
    assert.equal(row.channel_id, "chan_9");
    assert.equal(row.workspace_id, "ws_x");
  });

  it("defaults new sessions to the web source", () => {
    createSession({ id: "plain" });
    const row = openDb()
      .prepare("SELECT source, actor, channel_id FROM sessions WHERE id = ?")
      .get("plain") as { source: string; actor: string | null; channel_id: string | null };
    assert.equal(row.source, "web");
    assert.equal(row.actor, null);
    assert.equal(row.channel_id, null);
  });

  it("keeps listSessionsWithMessages source filtering consistent", () => {
    createSession({ id: "web-2" });
    createSession({ id: "im-2", source: "im" });
    const web = listSessionsWithMessages(undefined, { source: "web" });
    assert.deepEqual(
      web.map((session) => session.id),
      ["web-2"],
    );
  });

  it("replays selected workspaces and sources in two queries with message position order", (t) => {
    const wsA = createWorkspace({ name: "A" });
    const wsB = createWorkspace({ name: "B" });
    createSession({ id: "a-web", workspaceId: wsA.id });
    createSession({ id: "a-empty", workspaceId: wsA.id });
    createSession({ id: "a-im", workspaceId: wsA.id, source: "im" });
    createSession({ id: "b-web", workspaceId: wsB.id });
    const user = addMessage("a-web", { role: "user", content: "first", createdAt: 20 });
    const tool = addMessage("a-web", {
      role: "tool",
      content: "second",
      createdAt: 10,
      status: "stopped",
      tool_call_id: "call",
      tool_name: "search",
    });
    addMessage("a-im", { role: "user", content: "im only" });
    addMessage("b-web", { role: "user", content: "other workspace" });
    touchSession("a-empty", 30);
    const prepares = t.mock.method(openDb(), "prepare");
    const selected = listSessionsWithMessages(wsA.id);
    assert.equal(prepares.mock.callCount(), 2);
    assert.deepEqual(
      selected.map((session) => session.id),
      ["a-empty", "a-web"],
    );
    assert.deepEqual(selected[0]?.messages, []);
    assert.deepEqual(selected[1]?.messages, [user, tool]);
    assert.deepEqual(
      listSessionsWithMessages(wsA.id, { source: "im" }).map((session) => session.id),
      ["a-im"],
    );
    assert.equal(listSessionsWithMessages(wsA.id, { source: "all" }).length, 3);
    prepares.mock.resetCalls();
    assert.deepEqual(listSessionsWithMessages("missing-workspace"), []);
    assert.equal(prepares.mock.callCount(), 1);
  });
});
