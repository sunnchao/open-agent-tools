import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  estimateMessageTokens,
  estimateTokens,
  formatKiloTokens,
} from "./context-estimate.js";

describe("estimateTokens", () => {
  it("returns 0 for empty text", () => {
    assert.equal(estimateTokens(""), 0);
  });

  it("counts ascii lighter than CJK", () => {
    assert.ok(estimateTokens("你好") > estimateTokens("hi"));
  });

  it("adds per-message overhead", () => {
    assert.ok(estimateMessageTokens("user", "hi") > estimateTokens("hi"));
  });
});

describe("formatKiloTokens", () => {
  it("keeps small numbers readable", () => {
    assert.equal(formatKiloTokens(556), "556");
    assert.equal(formatKiloTokens(999), "999");
  });

  it("compacts thousands with one decimal", () => {
    assert.equal(formatKiloTokens(12_400), "12.4k");
    assert.equal(formatKiloTokens(24_000), "24k");
  });

  it("handles invalid input without throwing", () => {
    assert.equal(formatKiloTokens(Number.NaN), "—");
    assert.equal(formatKiloTokens(-1), "—");
  });
});
