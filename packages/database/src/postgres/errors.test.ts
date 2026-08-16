import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isPostgresError, isUniqueViolation } from "./errors.js";

describe("isPostgresError", () => {
  it("matches a top-level postgres error code", () => {
    const error = Object.assign(new Error("duplicate key"), { code: "23505" });
    assert.equal(isPostgresError(error, "23505"), true);
  });

  it("matches an error code found in the cause chain", () => {
    const cause = Object.assign(new Error("duplicate key"), { code: "23505" });
    const error = new Error("wrapped", { cause });
    assert.equal(isPostgresError(error, "23505"), true);
  });

  it("does not match unrelated error codes", () => {
    const error = Object.assign(new Error("boom"), { code: "28P01" });
    assert.equal(isPostgresError(error, "23505"), false);
  });

  it("returns false for non-object errors", () => {
    assert.equal(isPostgresError("string error", "23505"), false);
    assert.equal(isPostgresError(null, "23505"), false);
    assert.equal(isPostgresError(undefined, "23505"), false);
  });
});

describe("isUniqueViolation", () => {
  it("matches a unique violation code", () => {
    const error = Object.assign(new Error("duplicate key"), { code: "23505" });
    assert.equal(isUniqueViolation(error), true);
  });
});
