import assert from "node:assert/strict";
import { test } from "node:test";
import { ManagementError, requireAdmin, requireEditor } from "./authorization.js";
import type { Actor } from "./types.js";

const admin: Actor = { id: "admin", role: "admin" };
const operator: Actor = { id: "operator", role: "operator" };
const auditor: Actor = { id: "auditor", role: "auditor" };

function forbidden(action: () => void, message: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ManagementError);
    assert.equal(error.code, "FORBIDDEN");
    assert.equal(error.message, message);
    return true;
  });
}

test("editor access retains admin/operator access and auditor denial", () => {
  assert.doesNotThrow(() => requireEditor(admin));
  assert.doesNotThrow(() => requireEditor(operator));
  forbidden(() => requireEditor(auditor), "This operation requires admin or operator access");
});

test("admin access retains its stricter role gate and error contract", () => {
  assert.doesNotThrow(() => requireAdmin(admin));
  forbidden(() => requireAdmin(operator), "This operation requires admin access");
  forbidden(() => requireAdmin(auditor), "This operation requires admin access");
});
