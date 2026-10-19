import { describe, expect, it } from "vitest";
import { appendTurn, assistantSummary, carriedUserTurns, MAX_FOLLOW_UP_TURNS } from "./followUp.js";

describe("appendTurn", () => {
  it("appends a user/assistant pair", () => {
    expect(appendTurn([], "3 月的营收?", "生成的 SQL:\nSELECT 1")).toEqual([
      { role: "user", content: "3 月的营收?" },
      { role: "assistant", content: "生成的 SQL:\nSELECT 1" },
    ]);
  });

  it("ignores empty assistant text (no SQL, no clarifying)", () => {
    const history = [{ role: "user" as const, content: "问题" }];
    expect(appendTurn(history, "问题", "   ")).toEqual(history);
  });

  it("caps the context to the most recent turns", () => {
    let history = [] as ReturnType<typeof appendTurn>;
    for (let index = 0; index < 10; index += 1) {
      history = appendTurn(history, `q${index}`, `a${index}`);
    }
    expect(history).toHaveLength(MAX_FOLLOW_UP_TURNS);
    expect(history[history.length - 1]).toEqual({ role: "assistant", content: "a9" });
  });
});

describe("assistantSummary", () => {
  it("prefers the clarifying question", () => {
    expect(assistantSummary({ clarifying: "哪个字段?", generatedSql: "SELECT 1" })).toBe(
      "哪个字段?",
    );
  });

  it("falls back to the generated SQL", () => {
    expect(assistantSummary({ generatedSql: "SELECT 2" })).toBe("生成的 SQL:\nSELECT 2");
  });

  it("reports errors when there is no SQL", () => {
    expect(assistantSummary({ error: "connection refused" })).toBe("查询失败:connection refused");
  });

  it("returns empty string when there is nothing useful", () => {
    expect(assistantSummary({})).toBe("");
  });
});

describe("carriedUserTurns", () => {
  it("counts only user turns", () => {
    expect(
      carriedUserTurns([
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ]),
    ).toBe(2);
  });
});
