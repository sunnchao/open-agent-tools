import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectorStatusLabel,
  employeeEntryPath,
  linesToPatterns,
  localMessage,
  newId,
  patternsToText,
} from "./index.js";

test("connector status labels retain all supported client states", () => {
  assert.equal(connectorStatusLabel("success"), "成功");
  assert.equal(connectorStatusLabel("partial"), "部分成功");
  assert.equal(connectorStatusLabel("error"), "失败");
  assert.equal(connectorStatusLabel("idle"), "未同步");
  assert.equal(connectorStatusLabel(null), "未同步");
});

test("local messages and IDs are complete and independent", () => {
  const first = localMessage("user", "hello");
  const second = localMessage("user", "hello");
  assert.deepEqual(
    { role: first.role, content: first.content, status: first.status },
    { role: "user", content: "hello", status: "complete" },
  );
  assert.equal(typeof first.id, "string");
  assert.ok(first.id.length > 0);
  assert.ok(first.createdAt > 0);
  assert.notEqual(newId(), newId());
  assert.notEqual(first.id, second.id);
});

test("employee links encode access tokens exactly once", () => {
  assert.equal(employeeEntryPath("hr"), "#/app/hr");
  assert.equal(
    employeeEntryPath("hr", "token with spaces"),
    "#/app/hr?access_token=token%20with%20spaces",
  );
});

test("connector filter helpers round-trip trimmed unique patterns", () => {
  assert.deepEqual(linesToPatterns(" hr/*\n\n eng/* \nhr/*"), ["hr/*", "eng/*"]);
  assert.equal(patternsToText(["hr/*", "eng/*"]), "hr/*\neng/*");
});
