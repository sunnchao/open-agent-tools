import { describe, expect, it } from "vitest";
import {
  parallelCurveOffsets,
  relationPorts,
  rerouteRelationEdges,
  type RelationFlowEdge,
} from "./relationRouting.js";

describe("parallelCurveOffsets", () => {
  it("keeps a single relationship centered", () => {
    const offsets = parallelCurveOffsets([{ id: "a", source: "left", target: "right" }]);
    expect(offsets.get("a")).toBe(0);
  });

  it("spreads parallel relationships symmetrically", () => {
    const offsets = parallelCurveOffsets([
      { id: "a", source: "left", target: "right" },
      { id: "b", source: "left", target: "right" },
      { id: "c", source: "left", target: "right" },
    ]);
    expect([...offsets.values()]).toEqual([-28, 0, 28]);
  });

  it("keeps reverse relationships on separate physical lanes", () => {
    const offsets = parallelCurveOffsets([
      { id: "forward", source: "a", target: "b" },
      { id: "reverse", source: "b", target: "a" },
    ]);
    expect(offsets.get("forward")).toBe(-14);
    expect(offsets.get("reverse")).toBe(-14);
  });
});

describe("rerouteRelationEdges", () => {
  it("switches ports after a node crosses its target", () => {
    const edge = {
      id: "edge-a",
      source: "a",
      target: "b",
      type: "relation",
      sourceHandle: "right-source",
      targetHandle: "left-target",
      data: { rawId: "a", relType: "ref", curveOffset: 0 },
    } satisfies RelationFlowEdge;

    const [rerouted] = rerouteRelationEdges(
      [edge],
      [
        { id: "a", position: { x: 200, y: 0 } },
        { id: "b", position: { x: 0, y: 0 } },
      ],
    );
    expect(rerouted?.sourceHandle).toBe("left-source");
    expect(rerouted?.targetHandle).toBe("right-target");
  });
});

describe("relationPorts", () => {
  it("uses horizontal ports for a mostly horizontal edge", () => {
    expect(relationPorts({ x: 0, y: 0 }, { x: 100, y: 10 })).toEqual({
      sourceHandle: "right-source",
      targetHandle: "left-target",
    });
  });

  it("uses vertical ports for a mostly vertical edge", () => {
    expect(relationPorts({ x: 0, y: 100 }, { x: 10, y: 0 })).toEqual({
      sourceHandle: "top-source",
      targetHandle: "bottom-target",
    });
  });
});
