import { describe, expect, it } from "vitest";
import { normalizeTab } from "./tabs";

describe("workspace tab normalization", () => {
  it("degrades the legacy graph tab to the merged knowledge tab", () => {
    expect(normalizeTab("graph")).toBe("rag");
  });

  it("keeps valid tabs and falls back for unknown values", () => {
    expect(normalizeTab("rag")).toBe("rag");
    expect(normalizeTab("workflow")).toBe("workflow");
    expect(normalizeTab("removed-workspace")).toBe("workflow");
    expect(normalizeTab(undefined)).toBe("workflow");
  });
});
