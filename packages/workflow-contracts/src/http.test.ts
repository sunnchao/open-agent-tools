import assert from "node:assert/strict";
import { it } from "node:test";
import {
  nodeConfigSchemas,
  variableIssues,
  selectorIssue,
  interpolateTemplate,
  interpolateTemplateValue,
  portableHttpConfig,
  collectEndOutputs,
} from "./index.js";

it("validates all six HTTP methods, four body types, authentication and execution policy", () => {
  for (const method of ["get", "head", "post", "put", "patch", "delete"])
    assert.equal(
      nodeConfigSchemas.http.safeParse({ method, url: "https://example.com" }).success,
      true,
    );
  for (const type of ["none", "json", "raw", "form-data"])
    assert.equal(
      nodeConfigSchemas.http.safeParse({
        body: {
          type,
          data: type === "form-data" ? [{ key: "k", type: "text", value: "v" }] : "{}",
        },
      }).success,
      true,
    );
  for (const config of [
    { method: "trace" },
    { timeoutMs: 500 },
    { retry: { maxRetries: 4 } },
    { body: { type: "binary" } },
    { authorization: { type: "invalid" } },
  ])
    assert.equal(nodeConfigSchemas.http.safeParse(config).success, false);
});

it("validates nested template references and typed HTTP response selectors without allowing prototype access", () => {
  const node = {
    id: "http",
    kind: "http",
    config: {
      url: "https://example.com/{{response.items[0].id}}",
      method: "post",
      inputs: [{ name: "response", source: { type: "literal", value: {} } }],
      body: { type: "json", data: '{"{{ignored_key}}":"{{response.items[0].id}}"}' },
      outputs: [{ name: "id", selector: "$result.body.items[0].id" }],
    },
  };
  assert.deepEqual(variableIssues([node]), []);
  assert.equal(selectorIssue(node, "$result.missing"), "结果中不存在字段 missing");
  assert.match(selectorIssue(node, "$result.body.__proto__.secret")!, /格式无效/);
  assert.match(selectorIssue(node, "$result.body.items[-1]")!, /格式无效/);
  const issue = variableIssues([
    { ...node, config: { ...node.config, url: "{{respones.items[0].id}}" } },
  ])[0]!;
  assert.deepEqual(issue.suggestions, ["response.items[0].id"]);
});

it("preserves structured JSON types and safely resolves deep object and array paths", () => {
  const inputs = { response: { items: [{ id: 7 }] }, count: 2, flag: false };
  assert.equal(interpolateTemplate("id={{response.items[0].id}}", inputs), "id=7");
  assert.deepEqual(
    interpolateTemplateValue(
      { count: "{{count}}", flag: "{{flag}}", item: "{{response.items[0]}}" },
      inputs,
    ),
    { count: 2, flag: false, item: { id: 7 } },
  );
  assert.throws(() => interpolateTemplate("{{response.items[1].id}}", inputs), /不存在/);
  assert.throws(() => interpolateTemplate("{{response.constructor}}", inputs), /格式无效/);
});

it("removes fixed HTTP credentials and credential bindings from portable definitions without mutating the draft", () => {
  const config = {
    authorization: { type: "bearer" as const, config: { token: "private-bearer-value" } },
    headers: "Accept:application/json\nAuthorization:Bearer private-header-value",
  };
  const portable = portableHttpConfig(config);
  assert.equal(portable.authorization?.config?.token, "");
  assert.equal(portable.headers, "Accept:application/json");
  assert.equal(config.authorization.config.token, "private-bearer-value");
  const bound = portableHttpConfig({
    authorization: { type: "custom", config: { header: "X-Demo", value: "{{credential}}" } },
    inputs: [{ name: "credential", source: { type: "literal", value: "private-literal-value" } }],
    headers: "Authorization:Bearer {{credential}}",
  });
  assert.equal(bound.authorization?.config?.value, "{{credential}}");
  assert.deepEqual(bound.inputs?.[0]?.source, { type: "literal", value: "" });
  assert.equal(bound.headers, "Authorization:Bearer {{credential}}");
  assert.equal(
    portableHttpConfig({
      authorization: { type: "custom", config: { header: "X-Demo", value: "private-auth" } },
      headers: "X-Demo:private-header",
    }).headers,
    "",
  );
  assert.equal(
    portableHttpConfig({
      inputs: [{ name: "header", source: { type: "literal", value: "Authorization" } }],
      headers: "{{header}}:Bearer private-header",
    }).headers,
    "",
  );
});

it("merges only executed end outputs in execution order even when numeric IDs reorder object properties", () => {
  const nodes = [
    { id: "1", kind: "end" },
    { id: "10", kind: "end" },
    { id: "unused", kind: "end" },
    { id: "input", kind: "input" },
  ];
  assert.deepEqual(
    collectEndOutputs(
      nodes,
      {
        "1": { result: "later", onlyLater: true },
        "10": { result: "earlier", onlyEarlier: true },
        input: { internal: "hidden" },
      },
      ["input", "10", "1"],
    ),
    { result: "later", onlyEarlier: true, onlyLater: true },
  );
  assert.deepEqual(collectEndOutputs(nodes, {}, []), {});
});
