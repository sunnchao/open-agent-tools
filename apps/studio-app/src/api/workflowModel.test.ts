import { describe, expect, it } from "vitest";
import {
  createEdge,
  createNode,
  defaultConfig,
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
  it("keeps graph augmentation on the knowledge-retrieval node", () => {
    // 知识检索节点默认开启图谱增强，跳数默认 2。
    const rag = defaultConfig("rag");
    expect(rag.graph).toBe(true);
    expect(rag.graphHops).toBe(2);
  });
  it("migrates legacy graph nodes into knowledge retrieval", () => {
    const migrated = migrateNodeData(
      {
        id: "g1",
        kind: "graph",
        label: "图谱检索",
        config: { sources: ["doc-a"], topK: 5, query: "{{query}}" },
      },
      "g1",
    );
    expect(migrated.kind).toBe("rag");
    expect(migrated.label).toBe("知识检索");
    expect(migrated.config.graph).toBe(true);
    expect(migrated.config.graphHops).toBe(2);
    expect(migrated.config.sources).toEqual(["doc-a"]);
    expect(migrated.config.outputs).toEqual([{ name: "formatted", selector: "$result.formatted" }]);
    // 幂等：再次迁移不改变结果。
    expect(migrateNodeData({ ...migrated }, "g1")).toEqual(migrated);
    // 本地草稿恢复：hydrateWorkflowSnapshot 是草稿进入编辑器的唯一入口，同样要迁移旧节点。
    const hydrated = hydrateWorkflowSnapshot({
      name: "legacy-draft",
      nodes: [
        {
          id: "g1",
          data: {
            kind: "graph",
            label: "图谱检索",
            config: { sources: ["doc-a"], query: "{{query}}" },
          },
        } as never,
      ],
      edges: [],
    });
    expect((hydrated.nodes[0]?.data as { kind: string }).kind).toBe("rag");
    expect((hydrated.nodes[0]?.data as { config: Record<string, unknown> }).config.graph).toBe(
      true,
    );
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
  it("migrates legacy graph nodes when importing old files and clipboard", () => {
    // 旧导出文件：graph 节点不再是合法 kind，必须在 schema 校验前迁移为 rag。
    const legacyFile = {
      name: "legacy",
      version: 1,
      graph: {
        name: "legacy",
        nodes: [
          { id: "s", data: { kind: "start", label: "开始", config: {} } },
          {
            id: "g1",
            data: {
              kind: "graph",
              label: "图谱检索",
              config: { sources: ["doc-a"], query: "{{query}}" },
            },
          },
          {
            id: "e",
            data: { kind: "end", label: "结束", config: { outputs: [] } },
          },
        ],
        edges: [
          { source: "s", target: "g1" },
          { source: "g1", target: "e" },
        ],
      },
      runVariables: [],
    };
    const imported = parseWorkflowFile(JSON.stringify(legacyFile));
    const importedNodes = imported.nodes.map((n) => n.data as { kind: string; config: unknown });
    expect(importedNodes[1]?.kind).toBe("rag");
    expect(importedNodes[1]?.config).toMatchObject({ graph: true, graphHops: 2 });
    // 旧剪贴板：同一套迁移逻辑。
    const legacySelection = JSON.stringify({
      format: "open-agent-tools/workflow-selection",
      version: 1,
      graph: {
        name: "selection",
        nodes: [
          {
            id: "g1",
            data: {
              kind: "graph",
              label: "图谱检索",
              config: { sources: ["doc-a"], query: "{{query}}" },
            },
          },
        ],
        edges: [],
      },
    });
    const parsedSelection = parseSelection(legacySelection);
    expect((parsedSelection.nodes[0]?.data as { kind: string }).kind).toBe("rag");
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
