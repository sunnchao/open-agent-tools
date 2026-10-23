import assert from "node:assert/strict";
import { test } from "node:test";
import { updateRunEdges } from "./run-edges.js";

test("run-edge updates cover only incoming IDs and preserve caller state", () => {
  const current = { first: "active", second: "done" } as const;
  const updated = updateRunEdges(current, ["first", "third", "first"], "error");
  assert.deepEqual(updated, { first: "error", second: "done", third: "error" });
  assert.deepEqual(current, { first: "active", second: "done" });
  assert.notEqual(updated, current);
});
