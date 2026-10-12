import assert from "node:assert/strict";
import { it } from "node:test";
import type { ConditionOperator } from "@open-agent-tools/workflow-contracts";
import { evaluateConditionCases } from "./condition-rules.js";

function check(operator: ConditionOperator, left: unknown, right?: unknown) {
  return evaluateConditionCases(
    [{ id: "if", rules: [{ variable: "left", operator, value: right }] }],
    { left },
  );
}

it("supports all 14 operators with positive and negative results", () => {
  const examples: Array<[ConditionOperator, unknown, unknown, unknown]> = [
    ["contains", "hello", "ell", "xyz"],
    ["not_contains", "hello", "xyz", "ell"],
    ["start_with", "hello", "he", "lo"],
    ["end_with", "hello", "lo", "he"],
    ["is", true, true, false],
    ["is_not", true, false, true],
    ["eq", 3, 3, 4],
    ["neq", 3, 4, 3],
    ["gt", 3, 2, 3],
    ["gte", 3, 3, 4],
    ["lt", 3, 4, 3],
    ["lte", 3, 3, 2],
  ];
  for (const [operator, left, match, miss] of examples) {
    assert.deepEqual(check(operator, left, match), { result: "if", warnings: [] }, operator);
    assert.deepEqual(check(operator, left, miss), { result: "else", warnings: [] }, operator);
  }
  for (const left of [undefined, null, "", " \n ", [], {}]) {
    assert.equal(check("is_empty", left).result, "if");
    assert.equal(check("is_not_empty", left).result, "else");
  }
  for (const left of [0, false, "hi", [null], { a: 0 }]) {
    assert.equal(check("is_empty", left).result, "else");
    assert.equal(check("is_not_empty", left).result, "if");
  }
  assert.equal(check("contains", [1, false], false).result, "if");
  assert.equal(check("not_contains", [1, false], "1").result, "if");
});

it("treats mismatched and missing types as false even for negation and never exposes input values", () => {
  for (const operator of ["not_contains", "is_not", "neq", "gt"] as const) {
    const result = check(operator, 123456789, "secret-value");
    assert.equal(result.result, "else");
    assert.equal(result.warnings[0]?.operator, operator);
    assert.equal(JSON.stringify(result.warnings).includes("secret-value"), false);
    assert.equal(JSON.stringify(result.warnings).includes("123456789"), false);
    assert.equal(check(operator, undefined, "secret-value").result, "else");
  }
  for (const invalid of [Infinity, -Infinity, NaN])
    assert.equal(check("gte", invalid, 2).warnings.length, 1);
});

it("short circuits rules and cases, selects the first match and preserves template types", () => {
  const invalid = { variable: "unknown", operator: "is" as const, value: true };
  const yes = { variable: "score", operator: "gte" as const, value: "{{threshold}}" };
  const no = { ...yes, value: 100 };
  const cases = [
    { id: "if", logicalOperator: "and" as const, rules: [no, invalid] },
    { id: "elif", logicalOperator: "or" as const, rules: [yes, invalid] },
    { id: "later", rules: [invalid] },
  ];
  assert.deepEqual(evaluateConditionCases(cases, { score: 60, threshold: 50 }), {
    result: "elif",
    warnings: [],
  });
  assert.equal(
    evaluateConditionCases(
      [
        { id: "if", rules: [yes] },
        { id: "elif", rules: [yes] },
      ],
      { score: 60, threshold: 50 },
    ).result,
    "if",
  );
  assert.equal(
    evaluateConditionCases(
      [{ id: "if", rules: [{ variable: "payload.items[0].name", operator: "is", value: "item" }] }],
      { payload: { items: [{ name: "item" }] } },
    ).result,
    "if",
  );
  assert.equal(
    evaluateConditionCases(
      [{ id: "if", rules: [{ variable: "payload.optional", operator: "is_empty" }] }],
      { payload: {} },
    ).result,
    "if",
  );
});

it("rejects unsafe paths, undeclared bindings and incomplete cases", () => {
  assert.throws(() => evaluateConditionCases([], {}), /完成/);
  assert.throws(() => evaluateConditionCases([{ id: "if", rules: [] }], {}), /完成/);
  for (const variable of ["unknown", "payload.__proto__", "payload.constructor", "payload[fn()]"])
    assert.throws(
      () =>
        evaluateConditionCases([{ id: "if", rules: [{ variable, operator: "is_empty" }] }], {
          payload: {},
        }),
      /无效/,
    );
  assert.throws(
    () =>
      evaluateConditionCases([{ id: "if", rules: [{ variable: "left", operator: "eq" }] }], {
        left: 0,
      }),
    /比较值/,
  );
});
