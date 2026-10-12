import { describe, expect, it } from "vitest";
import { replayWorkflowRun } from "./runHistory.js";
import type { WorkflowRunHistory } from "./api.js";

const history: WorkflowRunHistory = {
  run: {
    id: "r",
    taskId: "t",
    workflowId: "w",
    versionId: null,
    user: "studio",
    source: "studio",
    status: "succeeded",
    inputs: {},
    outputs: { answer: "ok" },
    error: null,
    totalSteps: 1,
    totalTokens: 3,
    createdAt: "2026-10-11T09:00:00Z",
    finishedAt: "2026-10-11T09:00:01Z",
    elapsedTime: 1,
  },
  graph: { name: "Past graph", nodes: [], edges: [] },
  events: [
    {
      runId: "r",
      sequence: 1,
      type: "node_started",
      payload: { node_id: "llm", title: "Original name", node_type: "llm" },
      createdAt: "",
    },
    {
      runId: "r",
      sequence: 2,
      type: "node_finished",
      payload: {
        node_id: "llm",
        status: "success",
        inputs: { query: "hello" },
        outputs: { answer: "ok" },
        result: "ok",
        prompt: "hello",
        systemPrompt: "be helpful",
        metadata: {
          durationMs: 1000,
          tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
      },
      createdAt: "",
    },
  ],
};

describe("persisted workflow replay", () => {
  it("reconstructs labels, prompts, IO, duration and usage independent of current draft", () => {
    const result = replayWorkflowRun(history);
    expect(result.log[0]).toMatchObject({
      id: "llm",
      label: "Original name",
      kind: "llm",
      prompt: "hello",
      systemPrompt: "be helpful",
      durationMs: 1000,
      tokenUsage: { totalTokens: 3 },
      inputs: { query: "hello" },
      outputs: { answer: "ok" },
    });
    expect(result.outputs).toEqual({ answer: "ok" });
    expect(result.nodeOutputs).toEqual({ llm: { answer: "ok" } });
  });
  it("orders and deduplicates sequence records without changing the source", () => {
    const events = [history.events[1]!, history.events[0]!, history.events[1]!];
    expect(replayWorkflowRun({ ...history, events }).log).toHaveLength(1);
    expect(events[0]?.sequence).toBe(2);
  });
  it("shows terminal failure even when no node result exists and hides final outputs", () => {
    const result = replayWorkflowRun({
      ...history,
      run: { ...history.run, status: "failed", error: "required input missing" },
      events: [],
    });
    expect(result.log[0]).toMatchObject({ status: "error", detail: "required input missing" });
    expect(result.outputs).toBeNull();
  });
});
