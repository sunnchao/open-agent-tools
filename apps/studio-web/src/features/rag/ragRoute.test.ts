import { describe, expect, it } from "vitest";
import { parseHashRoute } from "../../lib/routing.js";
import { ragRouteState } from "./ragRoute.js";

describe("ragRouteState", () => {
  it("maps the legacy #/graph route to the graph view", () => {
    expect(ragRouteState(parseHashRoute("#/graph"))).toEqual({
      initialView: "graph",
      initialSource: null,
    });
  });

  it("treats the first segment of a legacy #/graph route as the document source", () => {
    expect(ragRouteState(parseHashRoute("#/graph/guide.md"))).toEqual({
      initialView: "graph",
      initialSource: "guide.md",
    });
  });

  it("decodes the source of a legacy #/graph route", () => {
    expect(ragRouteState(parseHashRoute("#/graph/%E4%BA%A7%E5%93%81%20100%25.md"))).toEqual({
      initialView: "graph",
      initialSource: "产品 100%.md",
    });
  });

  it("parses the native #/rag/<view>/<source> route", () => {
    expect(ragRouteState(parseHashRoute("#/rag/graph/guide.md"))).toEqual({
      initialView: "graph",
      initialSource: "guide.md",
    });
    expect(ragRouteState(parseHashRoute("#/rag/analytics"))).toEqual({
      initialView: "analytics",
      initialSource: null,
    });
  });

  it("keeps the default view for #/rag and unknown sub views", () => {
    expect(ragRouteState(parseHashRoute("#/rag"))).toEqual({});
    expect(ragRouteState(parseHashRoute("#/rag/unknown/guide.md"))).toEqual({});
  });

  it("ignores other workspaces", () => {
    expect(ragRouteState(parseHashRoute("#/chat/session-1"))).toEqual({});
  });
});
