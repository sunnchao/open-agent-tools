import assert from "node:assert/strict";
import { test } from "node:test";
import { quotePostgresIdentifier } from "./sql.js";

test("postgres identifier quoting escapes embedded quotes", () => {
  assert.equal(quotePostgresIdentifier("public"), '"public"');
  assert.equal(quotePostgresIdentifier('team"catalog'), '"team""catalog"');
});
