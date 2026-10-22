import assert from "node:assert/strict";
import test from "node:test";
import {
  accessGroups,
  documentMetadataPatch,
  queryFeedback,
  querySources,
} from "./request-validation.js";

test("querySources preserves omitted and explicit empty source filters", () => {
  assert.equal(querySources(undefined), undefined);
  assert.deepEqual(querySources([]), []);
});

test("querySources trims and deduplicates source names", () => {
  assert.deepEqual(querySources([" guide.md ", "guide.md", ""]), ["guide.md"]);
});

test("querySources rejects invalid or oversized filters", () => {
  assert.throws(() => querySources("guide.md"), /string array/);
  assert.throws(() => querySources([1]), /string array/);
  assert.throws(
    () => querySources(Array.from({ length: 51 }, (_, index) => `doc-${index}`)),
    /at most 50/,
  );
});

test("documentMetadataPatch 规范化标题和标签", () => {
  assert.deepEqual(
    documentMetadataPatch({ title: " 部署指南 ", tags: ["生产", "生产", " 运维 "] }),
    {
      title: "部署指南",
      tags: ["生产", "运维"],
    },
  );
  assert.deepEqual(documentMetadataPatch({ tags: [] }), { tags: [] });
});

test("documentMetadataPatch 拒绝空更新和越界字段", () => {
  assert.throws(() => documentMetadataPatch({}), /required/);
  assert.throws(() => documentMetadataPatch({ title: " " }), /1-160/);
  assert.throws(() => documentMetadataPatch({ tags: ["x".repeat(41)] }), /1-40/);
});

test("documentMetadataPatch 校验文档可见分组", () => {
  assert.deepEqual(documentMetadataPatch({ allowedGroups: [" hr ", "hr", "finance"] }), {
    allowedGroups: ["hr", "finance"],
  });
  assert.deepEqual(documentMetadataPatch({ allowedGroups: [] }), { allowedGroups: [] });
  assert.throws(() => accessGroups("hr"), /array/);
  assert.throws(() => accessGroups(["x".repeat(61)]), /1-60/);
  assert.throws(() => accessGroups(["*"]), /cannot contain/);
});

test("queryFeedback 校验评分和可选说明", () => {
  assert.deepEqual(queryFeedback({ rating: "positive", comment: " useful " }), {
    rating: "positive",
    comment: "useful",
  });
  assert.throws(() => queryFeedback({ rating: "neutral" }), /positive or negative/);
  assert.throws(() => queryFeedback({ rating: "negative", comment: "x".repeat(501) }), /500/);
});
