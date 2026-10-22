import { describe, expect, it } from "vitest";
import { buildHashRoute, parseHashRoute, sameRoute } from "./routing.js";

describe("parseHashRoute", () => {
  it("parses a workspace route without an entity", () => {
    expect(parseHashRoute("#/workflow")).toEqual({ workspace: "workflow", segments: [] });
  });

  it("parses a chat route with a session id", () => {
    expect(parseHashRoute("#/chat/session-1")).toEqual({
      workspace: "chat",
      segments: ["session-1"],
    });
  });

  it("parses a workflow route with a sub screen", () => {
    expect(parseHashRoute("#/workflow/wf-1/access")).toEqual({
      workspace: "workflow",
      segments: ["wf-1", "access"],
    });
  });

  it("accepts the legacy hash form without a leading slash", () => {
    expect(parseHashRoute("#chat")).toEqual({ workspace: "chat", segments: [] });
  });

  it("returns an empty workspace for an empty hash", () => {
    expect(parseHashRoute("")).toEqual({ workspace: "", segments: [] });
  });

  it("decodes percent encoded segments", () => {
    expect(parseHashRoute("#/chat/a%2Fb").segments).toEqual(["a/b"]);
  });

  it("keeps malformed percent encoding as-is", () => {
    expect(parseHashRoute("#/chat/100%").segments).toEqual(["100%"]);
  });
});

describe("buildHashRoute", () => {
  it("builds a workspace only route", () => {
    expect(buildHashRoute("workflow")).toBe("/workflow");
  });

  it("builds a route with an entity id", () => {
    expect(buildHashRoute("chat", ["session-1"])).toBe("/chat/session-1");
  });

  it("drops empty segments", () => {
    expect(buildHashRoute("workflow", ["wf-1", null, undefined, ""])).toBe("/workflow/wf-1");
  });

  it("escapes reserved characters", () => {
    expect(buildHashRoute("chat", ["a/b"])).toBe("/chat/a%2Fb");
  });

  it("keeps colons readable in ids", () => {
    expect(buildHashRoute("chat", ["app-7a01b0cc:183fed9a"])).toBe("/chat/app-7a01b0cc:183fed9a");
  });

  it("round trips through parseHashRoute", () => {
    const hash = buildHashRoute("workflow", ["wf-1", "access"]);
    expect(parseHashRoute(`#${hash}`)).toEqual({
      workspace: "workflow",
      segments: ["wf-1", "access"],
    });
  });
});

describe("sameRoute", () => {
  it("treats identical routes as equal", () => {
    expect(
      sameRoute({ workspace: "chat", segments: ["a"] }, { workspace: "chat", segments: ["a"] }),
    ).toBe(true);
  });

  it("detects different segments", () => {
    expect(
      sameRoute({ workspace: "chat", segments: ["a"] }, { workspace: "chat", segments: ["b"] }),
    ).toBe(false);
  });

  it("detects a different workspace", () => {
    expect(
      sameRoute({ workspace: "chat", segments: ["a"] }, { workspace: "workflow", segments: ["a"] }),
    ).toBe(false);
  });
});
