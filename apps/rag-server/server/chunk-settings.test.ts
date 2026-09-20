import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChunkStrategy, parseSemanticThreshold, parseSeparators } from "./chunk-settings.js";

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

test("parseChunkStrategy accepts explicit modes and fallback", () => {
  assert.equal(parseChunkStrategy(undefined), "fixed");
  assert.equal(parseChunkStrategy("semantic"), "semantic");
  assert.throws(() => parseChunkStrategy("auto"), /fixed or semantic/);
});

test("parseSemanticThreshold accepts inclusive 0-1 range", () => {
  assert.equal(parseSemanticThreshold(undefined), 0.75);
  assert.equal(parseSemanticThreshold("0.6"), 0.6);
  assert.equal(parseSemanticThreshold(0), 0);
  assert.equal(parseSemanticThreshold(1), 1);
  assert.throws(() => parseSemanticThreshold(1.1), /between 0 and 1/);
  assert.throws(() => parseSemanticThreshold("invalid"), /between 0 and 1/);
});
