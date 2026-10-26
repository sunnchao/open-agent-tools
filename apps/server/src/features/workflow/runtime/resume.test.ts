import assert from "node:assert/strict";
import { it } from "node:test";
import {
  prepareResumeCheckpoint,
  type CachedWorkflowNode,
} from "@open-agent-tools/workflow-contracts";
import { executeWorkflow, type WorkflowEvent, type WorkflowRunRequest } from "./executor.js";

it("resumes a five-node workflow from node three with genuine outputs and no upstream execution", async () => {
  const request: WorkflowRunRequest = {
    nodes: [
      { id: "s", kind: "start" },
      {
        id: "a",
        kind: "llm",
        config: { prompt: "seed", outputs: [{ name: "text", selector: "$result" }] },
      },
      {
        id: "b",
        kind: "input",
        config: {
          inputs: [{ name: "text", source: { type: "node", nodeId: "a", output: "text" } }],
          outputs: [{ name: "text", selector: "$inputs.text" }],
        },
      },
      {
        id: "c",
        kind: "llm",
        config: {
          prompt: "{{text}}",
          inputs: [{ name: "text", source: { type: "node", nodeId: "b", output: "text" } }],
          outputs: [{ name: "text", selector: "$result" }],
        },
      },
      {
        id: "end",
        kind: "end",
        config: {
          inputs: [{ name: "text", source: { type: "node", nodeId: "c", output: "text" } }],
          outputs: [{ name: "text", selector: "$inputs.text" }],
        },
      },
    ],
    edges: [
      ["s", "a"],
      ["a", "b"],
      ["b", "c"],
      ["c", "end"],
    ].map(([source, target], index) => ({ id: `e${index}`, source: source!, target: target! })),
    input: {},
  };
  let calls = 0;
  const dependencies = {
    getDefaultProvider: () => ({ id: "fixture", models: ["fixture"] }) as never,
    completeLlm: async (_provider: unknown, input: { prompt: string }) => {
      calls++;
      return `answer:${input.prompt}`;
    },
  };
  const cache: Record<string, CachedWorkflowNode> = {};
  const original = await executeWorkflow(
    request,
    (event) => {
      if (event.type === "node_result" && event.status === "success")
        cache[event.nodeId!] = {
          outputs: event.outputs!,
          result: event.result,
          inputs: event.inputs,
        };
    },
    dependencies,
  );
  assert.equal(calls, 2);
  calls = 0;
  const events: WorkflowEvent[] = [];
  const checkpoint = prepareResumeCheckpoint(request, request, "b", cache);
  const resumed = await executeWorkflow(request, (event) => events.push(event), {
    ...dependencies,
    resume: checkpoint,
  });
  assert.deepEqual(resumed, original);
  assert.equal(calls, 1);
  assert.deepEqual(
    events.filter((event) => event.type === "node_start").map((event) => event.nodeId),
    ["b", "c", "end"],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "node_cached").map((event) => event.nodeId),
    ["s", "a"],
  );
});
