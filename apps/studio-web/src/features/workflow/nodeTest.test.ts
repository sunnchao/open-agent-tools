import { describe, expect, it } from "vitest";
import type { WorkflowNodeData } from "./model.js";
import {
  createNodeTestInputDraft,
  describeNodeTestInputSource,
  parseNodeTestValue,
  serializeNodeTestValue,
} from "./nodeTest.js";

const data: WorkflowNodeData = {
  id: "llm-1",
  kind: "llm",
  label: "LLM",
  description: "",
  status: "idle",
  config: {
    inputs: [
      { name: "literal", source: { type: "literal", value: { ok: true } } },
      { name: "query", source: { type: "run", variable: "query" } },
      { name: "context", source: { type: "node", nodeId: "rag", output: "chunks" } },
    ],
  },
};

describe("workflow node test inputs", () => {
  it("serializes and parses scalar and structured test values", () => {
    expect(serializeNodeTestValue("hello")).toBe("hello");
    expect(parseNodeTestValue("hello")).toBe("hello");
    expect(parseNodeTestValue("3")).toBe(3);
    expect(parseNodeTestValue('{"ok":true}')).toEqual({ ok: true });
  });

  it("prefills values from literals, run inputs, and previous node outputs", () => {
    expect(
      createNodeTestInputDraft(data, { rag: { chunks: ["a", "b"] } }, { query: "question" }),
    ).toEqual({
      literal: '{\n  "ok": true\n}',
      query: "question",
      context: '[\n  "a",\n  "b"\n]',
    });
  });

  it("describes the configured input source", () => {
    const inputs = data.config.inputs as Parameters<typeof describeNodeTestInputSource>[0][];
    expect(inputs.map(describeNodeTestInputSource)).toEqual([
      "固定值",
      "运行输入 · query",
      "节点输出 · rag.chunks",
    ]);
  });
});
