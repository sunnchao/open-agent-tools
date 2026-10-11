import { describe, expect, it } from "vitest";
import { decorateRunEdges, updateRunEdges } from "./runEdges.js";

describe("runtime edge states", () => {
  it("only decorates edges explicitly selected by the executor, including joins", () => {
    const edges = [
      { id: "selected", source: "true", target: "join" },
      { id: "skipped", source: "false", target: "join" },
    ];
    const running = updateRunEdges({}, ["selected"], "active");
    expect(decorateRunEdges(edges, running).map((edge) => edge.animated)).toEqual([true, false]);
    const failed = updateRunEdges(running, ["selected"], "error");
    expect(failed).toEqual({ selected: "error" });
    expect(decorateRunEdges(edges, failed)[0]?.animated).toBe(false);
    expect(edges[0]).not.toHaveProperty("data");
    expect(decorateRunEdges(edges, {})[0]?.data?.runStatus).toBeUndefined();
  });
});
