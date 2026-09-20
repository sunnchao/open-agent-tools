import assert from "node:assert/strict";
import test from "node:test";
import { documentMetadataPatch, queryFeedback } from "./request-validation.js";

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

test("queryFeedback 校验评分和可选说明", () => {
  assert.deepEqual(queryFeedback({ rating: "positive", comment: " useful " }), {
    rating: "positive",
    comment: "useful",
  });
  assert.throws(() => queryFeedback({ rating: "neutral" }), /positive or negative/);
  assert.throws(() => queryFeedback({ rating: "negative", comment: "x".repeat(501) }), /500/);
});
