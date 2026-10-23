import assert from "node:assert/strict";
import { test } from "node:test";
import { retryAfterSeconds } from "./retry.js";

test("retry-after seconds rounds upward and keeps a one-second floor", () => {
  assert.equal(retryAfterSeconds(2_001, 1_000), 2);
  assert.equal(retryAfterSeconds(2_000, 1_000), 1);
  assert.equal(retryAfterSeconds(500, 1_000), 1);
});
