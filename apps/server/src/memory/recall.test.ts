import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closeDb, openDb } from "../db.js";
import { buildMemoryContext } from "./recall.js";
import { parseExtraction } from "./extract.js";
import { listFacts, setFactReview, writeFact } from "./store.js";

beforeEach(() => {
  openDb(":memory:");
});

afterEach(() => {
  closeDb();
});

function accepted(overrides: Partial<Parameters<typeof writeFact>[0]> = {}) {
  const fact = writeFact({
    workspaceId: "w1",
    scopeKind: "person",
    scopeKey: "person:c1:ou_1",
    subject: "person:c1:ou_1",
    kind: "preference",
    slug: "language",
    body: "偏好 TypeScript",
    ...overrides,
  });
  setFactReview(fact.id, true);
  return fact;
}

describe("buildMemoryContext", () => {
  it("returns an empty string when nothing matches", () => {
    assert.equal(buildMemoryContext({ workspaceId: "w1", query: "Rust" }), "");
  });

  it("injects pinned preferences and matched facts with provenance", () => {
    accepted({ sourceSessionId: "feishu:oc_1:u:ou_1" });
    accepted({ slug: "deadline", body: "Q4 目标是上线记忆模块", kind: "decision" });

    const context = buildMemoryContext({
      workspaceId: "w1",
      personId: "person:c1:ou_1",
      query: "上线",
    });
    assert.match(context, /相关长期记忆/);
    assert.match(context, /偏好 TypeScript/);
    assert.match(context, /Q4 目标是上线记忆模块/);
    assert.match(context, /来源：feishu:oc_1:u:ou_1/);
    assert.match(context, /以当前为准/);
  });

  it("never injects unreviewed facts", () => {
    writeFact({
      workspaceId: "w1",
      scopeKind: "person",
      scopeKey: "person:c1:ou_1",
      subject: "person:c1:ou_1",
      kind: "preference",
      slug: "secret",
      body: "未审核偏好",
    });
    assert.equal(
      buildMemoryContext({ workspaceId: "w1", personId: "person:c1:ou_1", query: "未审核" }),
      "",
    );
  });

  it("respects the character budget", () => {
    for (let index = 0; index < 5; index += 1) {
      accepted({ slug: `fact-${index}`, body: `预算事实${index}`.repeat(30) });
    }
    const context = buildMemoryContext({
      workspaceId: "w1",
      personId: "person:c1:ou_1",
      query: "预算事实",
      maxChars: 300,
    });
    assert.ok(context.length <= 300, `expected <=300 chars, got ${context.length}`);
  });

  it("stays inside its workspace", () => {
    accepted();
    assert.equal(buildMemoryContext({ workspaceId: "w2", query: "TypeScript" }), "");
    assert.equal(listFacts({ workspaceId: "w2", status: "all" }).length, 0);
  });
});

describe("parseExtraction", () => {
  it("keeps valid facts and drops malformed entries", () => {
    const facts = parseExtraction(
      `好的，结果如下：{"facts":[
        {"slug":"lang","kind":"preference","subject":"user:1","body":"偏好 TypeScript","confidence":"high"},
        {"slug":"","kind":"preference","subject":"user:1","body":"缺 slug"},
        {"slug":"bad-kind","kind":"nonsense","subject":"user:1","body":"坏类型"},
        {"slug":"group-rule","kind":"constraint","subject":"team","body":"周五不发版","groupScoped":true,"validFrom":"2026-09-01"}
      ]}`,
    );
    assert.equal(facts.length, 2);
    assert.equal(facts[0]!.slug, "lang");
    assert.equal(facts[0]!.confidence, "high");
    assert.equal(facts[1]!.groupScoped, true);
    assert.equal(facts[1]!.validFrom, "2026-09-01");
  });

  it("tolerates non-JSON output", () => {
    assert.deepEqual(parseExtraction("没有可记的内容"), []);
    assert.deepEqual(parseExtraction('{"facts":"not-an-array"}'), []);
  });
});
