import assert from "node:assert/strict";
import { test } from "node:test";
import { writeSseData } from "./sse.js";

test("SSE data writes one JSON frame with the standard blank-line terminator", () => {
  let written = "";
  writeSseData(
    {
      write(chunk: string) {
        written += chunk;
      },
    },
    { delta: "hello", count: 2 },
  );
  assert.equal(written, 'data: {"delta":"hello","count":2}\n\n');
});
