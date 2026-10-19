import assert from "node:assert/strict";
import { test } from "node:test";
import { buildClarification, clarificationSlotForPrompt } from "./clarification.js";

test("buildClarification returns the structured contract and preserves originalQuestion", () => {
  const built = buildClarification({
    question: "10",
    clarifying: "请确认需要查询多少条？",
    context: { originalQuestion: "查看用户" },
  });
  assert.equal(built.repeated, false);
  assert.equal(built.slot.key, "row_limit");
  assert.equal(built.clarification.originalQuestion, "查看用户");
  assert.equal(built.clarification.round, 1);
  assert.deepEqual(built.clarification.missingSlots, ["row_limit"]);
  assert.equal(built.clarification.canProceed, false);
  assert.ok(built.clarification.candidates.some((candidate) => candidate.value === "50"));
  assert.equal(built.clarification.clarifying, "请确认需要查询多少条？");
});

test("buildClarification detects a repeated slot from plain legacy history", () => {
  const built = buildClarification({
    question: "全部",
    clarifying: "请确认需要查询多少条？",
    history: [{ role: "assistant", content: "请确认需要查询多少条？" }],
    context: { round: 1 },
  });
  assert.equal(built.repeated, true);
  assert.equal(built.clarification.round, 2);
  assert.deepEqual(built.clarification.missingSlots, []);
});

test("buildClarification reads structured missingSlots from history", () => {
  const assistant = JSON.stringify({
    clarification: {
      slots: [{ key: "time_range" }],
      missingSlots: ["time_range"],
    },
  });
  const built = buildClarification({
    question: "本月",
    clarifying: "请补充时间范围",
    history: [{ role: "assistant", content: assistant }],
  });
  assert.equal(built.repeated, true);
  assert.equal(clarificationSlotForPrompt("请补充时间范围"), "time_range");
});
