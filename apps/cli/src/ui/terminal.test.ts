import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClearRenderedLinesSequence } from "./terminal.ts";

describe("createClearRenderedLinesSequence", () => {
  it("does nothing when no output has been rendered", () => {
    assert.equal(createClearRenderedLinesSequence(0), "");
  });

  it("clears one line without writing a newline", () => {
    assert.equal(createClearRenderedLinesSequence(1), "\r\x1b[2K\r");
  });

  it("moves up N - 1 rows and never scrolls the terminal", () => {
    const sequence = createClearRenderedLinesSequence(3);

    assert.equal(sequence, "\r\x1b[2A\x1b[2K\x1b[1B\x1b[2K\x1b[1B\x1b[2K\x1b[2A\r");
    assert.equal(sequence.includes("\n"), false);
  });
});
