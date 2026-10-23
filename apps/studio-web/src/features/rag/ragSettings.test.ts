import { describe, expect, it } from "vitest";
import {
  DEFAULT_RAG_SEPARATORS,
  separatorsFromText,
  separatorsToText,
  validateSeparators,
} from "./ragSettings.js";

describe("RAG separator settings", () => {
  it("round-trips escaped separators and removes duplicates", () => {
    const text = separatorsToText(["\\", "\n", "\r", "\t", " ", "\n"]);
    expect(separatorsFromText(text)).toEqual(["\\", "\n", "\r", "\t", " "]);
    expect(separatorsFromText(separatorsToText(DEFAULT_RAG_SEPARATORS))).toEqual(
      DEFAULT_RAG_SEPARATORS,
    );
  });

  it("keeps empty lines out and validates cloud limits", () => {
    expect(separatorsFromText("\n\\n\n\n")).toEqual(["\n"]);
    expect(validateSeparators([])).toContain("至少");
    expect(validateSeparators(Array.from({ length: 21 }, (_, index) => String(index)))).toContain(
      "20",
    );
    expect(validateSeparators(["x".repeat(33)])).toContain("32");
    expect(validateSeparators(DEFAULT_RAG_SEPARATORS)).toBeNull();
  });
});
