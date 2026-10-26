import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb, openDb } from "../db.js";
import {
  forgetMemory,
  getSummary,
  isForgottenSession,
  listFacts,
  recordLineage,
  resolvePersonId,
  searchFacts,
  setFactReview,
  upsertSummary,
  writeFact,
} from "./store.js";

beforeEach(() => {
  openDb(":memory:");
});

afterEach(() => {
  closeDb();
});

function write(overrides: Partial<Parameters<typeof writeFact>[0]> = {}) {
  return writeFact({
    workspaceId: "w1",
    scopeKind: "person",
    scopeKey: "person:c1:feishu_open_id:ou_1",
    subject: "person:c1:feishu_open_id:ou_1",
    kind: "preference",
    slug: "language",
    body: "用户偏好 TypeScript",
    confidence: "high",
    ...overrides,
  });
}

describe("fact lifecycle", () => {
  it("supersedes the previous active fact and keeps history", () => {
    const first = write();
    const second = write({ body: "用户改用 Rust", validFrom: "2026-09-01" });
    setFactReview(second.id, true);

    assert.equal(second.supersedesId, first.id);
    const active = listFacts({ workspaceId: "w1", scopeKey: first.scopeKey });
    assert.deepEqual(active.map((fact) => fact.body), ["用户改用 Rust"]);

    const all = listFacts({ workspaceId: "w1", status: "all", includeUnreviewed: true });
    assert.equal(all.length, 2);
    const superseded = all.find((fact) => fact.id === first.id)!;
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.validTo, "2026-09-01");
  });

  it("hides unreviewed facts from recall until accepted", () => {
    const fact = write({ body: "用户所在团队是增长组" });
    assert.deepEqual(searchFacts("增长组", { workspaceId: "w1" }), []);

    setFactReview(fact.id, true);
    const matches = searchFacts("增长组", { workspaceId: "w1" });
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.id, fact.id);
  });

  it("rejecting a proposal removes it entirely", () => {
    const fact = write();
    setFactReview(fact.id, false);
    assert.equal(listFacts({ workspaceId: "w1", status: "all", includeUnreviewed: true }).length, 0);
  });

  it("isolates workspaces and scopes", () => {
    const fact = write();
    setFactReview(fact.id, true);
    assert.equal(searchFacts("TypeScript", { workspaceId: "w2" }).length, 0);
    assert.equal(
      searchFacts("TypeScript", { workspaceId: "w1", scopeKey: "person:other" }).length,
      0,
    );
  });
});

describe("summary cursor", () => {
  it("only advances the covered position", () => {
    assert.equal(
      upsertSummary({ sessionId: "s1", summary: "第一段", coveredThroughPosition: 10 }),
      true,
    );
    assert.equal(
      upsertSummary({ sessionId: "s1", summary: "回退段", coveredThroughPosition: 5 }),
      false,
    );
    const summary = getSummary("s1");
    assert.equal(summary?.summary, "第一段");
    assert.equal(summary?.coveredThroughPosition, 10);
  });
});

describe("person links", () => {
  it("returns a stable canonical id per external identity", () => {
    const first = resolvePersonId({
      workspaceId: "w1",
      channelId: "c1",
      platform: "feishu",
      idType: "feishu_open_id",
      externalId: "ou_1",
    });
    const again = resolvePersonId({
      workspaceId: "w1",
      channelId: "c1",
      platform: "feishu",
      idType: "feishu_open_id",
      externalId: "ou_1",
    });
    const other = resolvePersonId({
      workspaceId: "w1",
      channelId: "c1",
      platform: "dingtalk",
      idType: "dingtalk_staff_id",
      externalId: "ou_1",
    });
    assert.equal(first, again);
    assert.notEqual(first, other);
  });
});

describe("forget", () => {
  it("purges facts by session lineage and blocks re-ingestion", () => {
    const fact = write();
    recordLineage({ factId: fact.id, sessionId: "s1", messageId: "m1", actor: "ou_1" });
    upsertSummary({ sessionId: "s1", summary: "摘要", coveredThroughPosition: 3 });

    const result = forgetMemory({ workspaceId: "w1", sessionId: "s1" });
    assert.equal(result.facts, 1);
    assert.equal(result.summaries, 1);
    assert.equal(listFacts({ workspaceId: "w1", status: "all", includeUnreviewed: true }).length, 0);
    assert.equal(getSummary("s1"), null);
    assert.equal(isForgottenSession("w1", "s1"), true);
  });

  it("purges every fact owned by a person scope", () => {
    const personId = "person:c1:feishu_open_id:ou_1";
    write({ slug: "a", body: "事实A" });
    write({ slug: "b", body: "事实B" });
    const result = forgetMemory({ workspaceId: "w1", personId });
    assert.equal(result.facts, 2);
    assert.equal(listFacts({ workspaceId: "w1", status: "all", includeUnreviewed: true }).length, 0);
  });
});
