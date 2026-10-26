import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateConditionExpression } from "./expression.js";

describe("safe workflow condition expressions", () => {
  it("evaluates boolean, equality, comparison, and grouping operators", () => {
    assert.equal(evaluateConditionExpression("true"), true);
    assert.equal(evaluateConditionExpression('(4 >= 3 && "pro" === "pro") || false'), true);
    assert.equal(evaluateConditionExpression("!(2 > 3)"), true);
    assert.equal(evaluateConditionExpression("null != null"), false);
  });

  it("rejects property access, calls, and executable JavaScript", () => {
    assert.throws(() => evaluateConditionExpression("process.exit(1)"), /unsupported token/);
    assert.throws(() => evaluateConditionExpression("({}).constructor"), /expected|unsupported/);
    assert.throws(() => evaluateConditionExpression('"x".includes("x")'), /unsupported token/);
  });

  it("requires matching operand types and a boolean result", () => {
    assert.throws(() => evaluateConditionExpression('2 > "1"'), /matching string or number/);
    assert.throws(() => evaluateConditionExpression("42"), /must return boolean/);
  });
});
