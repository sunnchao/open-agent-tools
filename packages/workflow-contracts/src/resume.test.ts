import assert from "node:assert/strict";
import { it } from "node:test";
import { prepareResumeCheckpoint, type ResumeGraph } from "./resume.js";

const graph: ResumeGraph = {
  nodes: ["s", "a", "b", "c", "end"].map((id) => ({
    id,
    kind: id === "s" ? "start" : "input",
    config: {},
  })),
  edges: [
    ["s", "a"],
    ["a", "b"],
    ["b", "c"],
    ["c", "end"],
  ].map(([source, target], index) => ({ id: `e${index}`, source: source!, target: target! })),
};
const cache = Object.fromEntries(
  graph.nodes.map((node) => [node.id, { outputs: { value: node.id } }]),
);
it("reuses only required prefix nodes and permits changes from the chosen node onwards", () => {
  const changed = structuredClone(graph);
  changed.nodes[2]!.config = { prompt: "changed" };
  const checkpoint = prepareResumeCheckpoint(changed, graph, "b", cache);
  assert.deepEqual(checkpoint.executeNodeIds, ["b", "c", "end"]);
  assert.deepEqual(Object.keys(checkpoint.cachedNodes), ["s", "a"]);
  assert.deepEqual(checkpoint.activeEdgeIds, ["e0", "e1"]);
  changed.nodes[1]!.config = { prompt: "stale" };
  assert.throws(() => prepareResumeCheckpoint(changed, graph, "b", cache), /上游节点 a 已修改/);
});
it("rejects absent outputs, changed incoming edges and unknown resume targets", () => {
  assert.throws(() => prepareResumeCheckpoint(graph, graph, "b", { b: cache.b! }), /缓存缺失/);
  assert.throws(() => prepareResumeCheckpoint(graph, graph, "missing", cache), /不在当前草稿/);
  const changed = structuredClone(graph);
  changed.edges[1]!.source = "s";
  assert.throws(
    () => prepareResumeCheckpoint(changed, graph, "b", cache),
    /续跑节点的上游连接已修改/,
  );
});
it("retains the selected condition path at joins without requiring skipped branch caches", () => {
  const branched: ResumeGraph = {
    nodes: [
      { id: "s", kind: "start" },
      { id: "route", kind: "condition" },
      { id: "yes", kind: "input" },
      { id: "no", kind: "input" },
      { id: "end", kind: "end" },
    ],
    edges: [
      { id: "s-route", source: "s", target: "route" },
      { id: "route-yes", source: "route", target: "yes", label: "true" },
      { id: "route-no", source: "route", target: "no", label: "false" },
      { id: "yes-end", source: "yes", target: "end" },
      { id: "no-end", source: "no", target: "end" },
    ],
  };
  const cached = {
    s: { outputs: {} },
    route: { outputs: {}, result: true },
    yes: { outputs: { value: 1 } },
    end: { outputs: {} },
  };
  const checkpoint = prepareResumeCheckpoint(branched, branched, "yes", cached);
  assert.deepEqual(Object.keys(checkpoint.cachedNodes), ["s", "route"]);
  assert.equal(checkpoint.activeEdgeIds.includes("route-no"), false);
  const joinCheckpoint = prepareResumeCheckpoint(branched, branched, "end", cached);
  assert.deepEqual(Object.keys(joinCheckpoint.cachedNodes), ["s", "route", "yes"]);
  assert.equal(joinCheckpoint.activeEdgeIds.includes("no-end"), false);
  assert.throws(
    () => prepareResumeCheckpoint(branched, branched, "no", cached),
    /没有成功运行的缓存/,
  );
});
