import assert from "node:assert/strict";
import test from "node:test";
import { querySources } from "./query-settings.js";

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
