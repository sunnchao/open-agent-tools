import assert from "node:assert/strict";
import test from "node:test";
import { formatHistoryText } from "./promptHistory.js";

const history = [
  { role: "user" as const, content: "first" },
  { role: "assistant" as const, content: "second" },
  { role: "user" as const, content: "third" },
];

test("formatHistoryText labels all turns when no limit is provided", () => {
  assert.equal(formatHistoryText(history), "用户: first\n助手: second\n用户: third");
});

test("formatHistoryText keeps only the latest requested turns", () => {
  assert.equal(formatHistoryText(history, 2), "助手: second\n用户: third");
  assert.equal(formatHistoryText(history, 6), "用户: first\n助手: second\n用户: third");
  assert.equal(formatHistoryText([]), "");
});
