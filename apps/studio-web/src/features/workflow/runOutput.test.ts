import { describe, expect, it } from "vitest";
import { formatWorkflowRunOutput } from "./runOutput.js";

describe("formatWorkflowRunOutput", () => {
  it("prints strings without JSON quoting", () => {
    expect(formatWorkflowRunOutput("answer")).toBe("answer");
  });

  it("pretty prints structured values", () => {
    expect(formatWorkflowRunOutput({ answer: "ok", sources: ["guide.md"] })).toBe(
      '{\n  "answer": "ok",\n  "sources": [\n    "guide.md"\n  ]\n}',
    );
  });

  it("handles undefined and values JSON cannot serialize", () => {
    expect(formatWorkflowRunOutput(undefined)).toBe("undefined");
    expect(formatWorkflowRunOutput(1n)).toBe("1");
  });
});
