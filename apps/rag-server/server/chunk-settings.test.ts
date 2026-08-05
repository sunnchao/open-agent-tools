import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSeparators } from "./chunk-settings.js";

test("parseSeparators parses JSON and removes duplicates without changing order", () => {
  assert.deepEqual(parseSeparators(JSON.stringify(["\n\n", "。", "。", " "]), ["fallback"]), [
    "\n\n",
    "。",
    " ",
  ]);
});

test("parseSeparators uses a copy of the fallback when the setting is omitted", () => {
  const fallback = ["\n", " "];
  const result = parseSeparators(undefined, fallback);
  assert.deepEqual(result, fallback);
  assert.notEqual(result, fallback);
});

test("parseSeparators rejects invalid settings", () => {
  assert.throws(() => parseSeparators("not-json", ["\n"]), /JSON string array/);
  assert.throws(() => parseSeparators("[]", ["\n"]), /1-20 items/);
  assert.throws(() => parseSeparators('[""]', ["\n"]), /non-empty string/);
  assert.throws(() => parseSeparators(JSON.stringify(["x".repeat(33)]), ["\n"]), /32/);
});
