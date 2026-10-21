import { describe, expect, it } from "vitest";
import {
  createEdge,
  createNode,
  hydrateWorkflowSnapshot,
  inputOptions,
  migrateNodeData,
  outputOptions,
  replaceTemplateReference,
  validateWorkflowGraph,
} from "./workflowModel";
import {
  canConnectTarget,
  cloneSubgraph,
  constrainGrantScopes,
  createNodeTestInputDraft,
  formatWorkflowRunOutput,
  grantCapabilities,
  parseSelection,
  parseWorkflowFile,
  replayWorkflowRun,
  serializeNodeTestValue,
  parseNodeTestValue,
  serializeSelection,
  serializeWorkflow,
  updateRunEdges,
} from "./workflowUtils";
import { __resetAuth } from "../lib/http";

describe("workflow model", () => {
  it("creates and migrates nodes", () => {
    const n = createNode("n1", "llm");
    expect((n.data as { kind: string }).kind).toBe("llm");
    const m = migrateNodeData({ id: "x", kind: "mcp", config: { service: "s", tool: "t" } }, "x");
    expect(m.config.serviceSlug).toBe("s");
  });
  it("validates graph topology and resources", () => {
    const start = {
      id: "s",
      data: { kind: "start" as const, label: "开始", description: "", config: {} },
    };
    const end = {
      id: "e",
      data: {
        kind: "end" as const,
        label: "结束",
        description: "",
        config: { outputs: [{ name: "o", selector: "$result" }] },
      },
    };
    const issues = validateWorkflowGraph([start, end], [{ source: "s", target: "e" }], {
      mcp: { configured: true, services: [] },
      rag: { sources: [] },
    });
    expect(issues).toEqual([]);
    expect(validateWorkflowGraph([], [], null).some((i) => i.code === "empty")).toBe(true);
    const loop = validateWorkflowGraph(
      [start, end],
      [
        { source: "s", target: "e" },
        { source: "e", target: "s" },
      ],
      null,
    );
    expect(loop.some((i) => i.code === "cycle")).toBe(true);
  });
  it("supports variable options and template replace", () => {
    expect(inputOptions({ id: "n", data: { kind: "llm", config: {} } }, [], []).at(-1)?.label).toBe(
      "固定值",
    );
    expect(
      outputOptions({ id: "n", data: { kind: "llm", config: {} } }).some(
        (o) => o.value === "$result",
      ),
    ).toBe(true);
    expect(replaceTemplateReference("hi {{name}}", "name", "nick")).toBe("hi {{nick}}");
    expect(replaceTemplateReference(JSON.stringify({ a: "{{x}}" }), "x", "y", true)).toContain(
      "{{y}}",
    );
    expect(serializeNodeTestValue({ a: 1 })).toContain('"a"');
    expect(parseNodeTestValue("  ")).toBe("");
    expect(formatWorkflowRunOutput(undefined)).toBe("undefined");
  });
  it("hydrates snapshots and checks connections", () => {
    const h = hydrateWorkflowSnapshot({
      name: "w",
      nodes: [createNode("s", "start"), createNode("e", "end")],
      edges: [],
    });
    expect(h.nodes.length).toBe(2);
    expect(
      canConnectTarget("s", "e", [{ id: "s", data: { kind: "start" } }, { id: "e" }], []),
    ).toBe(true);
    expect(canConnectTarget("e", "e", [{ id: "e" }], [])).toBe(false);
    expect(updateRunEdges({}, ["e1"], "done")).toEqual({ e1: "done" });
  });
  it("serializes/parses workflow files and selections", () => {
    const snap = {
      name: "w",
      nodes: [createNode("s", "start"), createNode("e", "end")],
      edges: [createEdge("s", "e")],
    };
    const text = serializeWorkflow(snap);
    expect(JSON.parse(text).version).toBe(1);
    expect(parseWorkflowFile(text).name).toBe("w");
    const sel = serializeSelection(snap.nodes, snap.edges, new Set(["e"]));
    expect(parseSelection(sel).nodes.length).toBe(1);
    const cloned = cloneSubgraph(snap.nodes, snap.edges, new Set(["e"]));
    expect(cloned.nodes.length).toBe(1);
    expect(cloned.nodes[0]?.id).not.toBe("e");
    __resetAuth();
  });
  it("replays run history", () => {
    const history = {
      run: { id: "r", outputs: { a: 1 }, error: null },
      events: [
        {
          runId: "r",
          sequence: 1,
          type: "node_started",
          payload: { node_id: "n", title: "N", node_type: "llm" },
          createdAt: "",
        },
        {
          runId: "r",
          sequence: 2,
          type: "node_finished",
          payload: {
            node_id: "n",
            status: "success",
            outputs: { a: 1 },
            metadata: { durationMs: 1 },
          },
          createdAt: "",
        },
      ],
      graph: { name: "w", nodes: [{ id: "n", data: { kind: "llm", label: "N" } }], edges: [] },
    };
    const replayed = replayWorkflowRun(history as never);
    expect(replayed.log.length).toBe(1);
    expect(replayed.outputs).toEqual({ a: 1 });
  });
  it("constrains grant scopes", () => {
    const caps = grantCapabilities({ currentVersionId: "v" }, [
      { id: "v", status: "PUBLISHED", versionNumber: 1, tools: [{}], prompts: [] },
    ]);
    expect(caps.toolCount).toBe(1);
    expect(constrainGrantScopes(["tools:call", "prompts:get"], caps)).toEqual([
      "mcp:connect",
      "tools:call",
    ]);
  });
  it("builds node test drafts", () => {
    const draft = createNodeTestInputDraft(
      { config: { inputs: [{ name: "q", source: { type: "run", variable: "query" } }] } },
      null,
      { query: "hi" },
    );
    expect(draft).toEqual({ q: "hi" });
  });
});
