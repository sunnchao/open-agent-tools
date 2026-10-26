import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb, openDb } from "../../platform/db.js";
import {
  forgetMemory,
  getMemoryStats,
  getSummary,
  isForgottenSession,
  listFactHistory,
  listFacts,
  listFactsPage,
  listRecentFacts,
  locateForgetTargets,
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

/** 写入并立即审核通过：多数用例只关心“已生效”的事实。 */
function accepted(overrides: Partial<Parameters<typeof writeFact>[0]> = {}) {
  const fact = write(overrides);
  setFactReview(fact.id, true);
  return fact;
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

describe("fact paging and history", () => {
  it("pages with a total that ignores limit/offset", () => {
    for (let index = 0; index < 5; index += 1) {
      write({ slug: `p-${index}`, body: `分页事实${index}` });
    }
    const first = listFactsPage({ workspaceId: "w1", limit: 2, offset: 0, includeUnreviewed: true });
    assert.equal(first.facts.length, 2);
    assert.equal(first.total, 5);

    const second = listFactsPage({ workspaceId: "w1", limit: 2, offset: 2, includeUnreviewed: true });
    assert.equal(second.facts.length, 2);
    assert.equal(second.total, 5);
    assert.notEqual(first.facts[0]!.id, second.facts[0]!.id);
  });

  it("filters by keyword across slug, subject and body", () => {
    write({ slug: "lang", body: "偏好 TypeScript" });
    write({ slug: "timezone", body: "时区是东八区" });
    const page = listFactsPage({ workspaceId: "w1", keyword: "typescript", includeUnreviewed: true });
    assert.equal(page.total, 1);
    assert.equal(page.facts[0]!.slug, "lang");
  });

  it("returns every version of the same fact, oldest first", () => {
    const first = write({ body: "旧值", recordedAt: 1_000 });
    const second = write({ body: "新值", recordedAt: 2_000 });
    const history = listFactHistory(second);
    assert.deepEqual(history.map((fact) => fact.body), ["旧值", "新值"]);
    assert.equal(history[0]!.id, first.id);
    assert.equal(history[1]!.status, "active");
  });
});

describe("stats and forget preview", () => {
  it("aggregates counts by status, kind and scope", () => {
    const first = accepted({ slug: "a", kind: "preference" });
    accepted({ slug: "b", kind: "constraint" });
    write({ slug: "pending", body: "待审核事实" });
    write({ slug: "c", body: "旧值" });
    write({ slug: "c", body: "新值" });
    assert.ok(first.id);

    const stats = getMemoryStats("w1");
    assert.equal(stats.active, 4);
    assert.equal(stats.unreviewed, 3);
    assert.equal(stats.superseded, 1);
    assert.equal(stats.persons, 1);
    assert.equal(stats.groups, 0);
    assert.equal(stats.byKind.preference, 3);
    assert.equal(stats.byKind.constraint, 1);
    assert.equal(stats.byKind.fact, undefined);
    assert.equal(stats.byScope.person, 4);
  });

  it("previews exactly what forget removes", () => {
    const fact = write();
    recordLineage({ factId: fact.id, sessionId: "s9" });
    upsertSummary({ sessionId: "s9", summary: "摘要", coveredThroughPosition: 2 });

    const preview = locateForgetTargets({ workspaceId: "w1", sessionId: "s9" });
    const result = forgetMemory({ workspaceId: "w1", sessionId: "s9" });
    assert.equal(preview.factIds.length, result.facts);
    assert.equal(preview.summaries, result.summaries);
    assert.equal(preview.lineage, result.lineage);
  });

  it("lists recent facts newest first including unreviewed", () => {
    write({ slug: "old", recordedAt: 1_000 });
    write({ slug: "new", recordedAt: 5_000 });
    const recent = listRecentFacts("w1", 10);
    assert.equal(recent[0]!.slug, "new");
    assert.equal(recent.length, 2);
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
