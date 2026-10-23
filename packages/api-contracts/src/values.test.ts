import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompletedMessage } from "./chat.js";
import {
  asRecord,
  errorMessage,
  isRecord,
  nonNegativeInteger,
  normalizeStringList,
  optionalString,
  parseDelimitedStringList,
  parseJsonStringList,
  safeDecodeUriComponent,
  trimmedString,
} from "./values.js";

test("string lists trim, remove empty values and preserve first-seen order", () => {
  assert.deepEqual(normalizeStringList([" beta ", "", "alpha", "beta", 3, null]), [
    "beta",
    "alpha",
  ]);
  assert.deepEqual(normalizeStringList("not an array"), []);
});

test("JSON string-list parsing preserves valid values and tolerates malformed storage", () => {
  assert.deepEqual(parseJsonStringList('[" one ", "", "two", "one"]'), ["one", "two"]);
  assert.deepEqual(parseJsonStringList('{"value":"not-a-list"}'), []);
  assert.deepEqual(parseJsonStringList("{malformed"), []);
});

test("delimited string lists use user-facing separators and preserve first-seen order", () => {
  assert.deepEqual(parseDelimitedStringList(" one, two，one\n\n three "), ["one", "two", "three"]);
  assert.deepEqual(parseDelimitedStringList("a|b|a", "|"), ["a", "b"]);
});

test("value helpers retain optional-string and error-message behavior", () => {
  const record = { name: "value" };
  assert.equal(isRecord(record), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(asRecord(record), record);
  assert.deepEqual(asRecord(null), {});
  assert.equal(trimmedString(" value "), "value");
  assert.equal(trimmedString(" "), null);
  assert.equal(optionalString(" value "), "value");
  assert.equal(optionalString(3), undefined);
  assert.equal(nonNegativeInteger(3.9), 3);
  assert.equal(nonNegativeInteger(0), 0);
  assert.equal(nonNegativeInteger(-1), 0);
  assert.equal(nonNegativeInteger(Number.NaN), 0);
  assert.equal(safeDecodeUriComponent("a%20b"), "a b");
  assert.equal(safeDecodeUriComponent("bad%"), "bad%");
  assert.equal(errorMessage(new Error("failure")), "failure");
  assert.equal(errorMessage("failure"), "failure");
});

test("completed message factory assigns the provided identity and timestamp", () => {
  assert.deepEqual(createCompletedMessage("assistant", "hello", "message-1", 42), {
    id: "message-1",
    role: "assistant",
    content: "hello",
    createdAt: 42,
    status: "complete",
  });
});
