import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMcpResponseBody } from "./response.js";

test("parses plain JSON and the final SSE data payload", () => {
  assert.deepEqual(parseMcpResponseBody('{"ok":true}', "application/json"), { ok: true });
  assert.deepEqual(
    parseMcpResponseBody(
      'event: message\ndata: {"step":1}\r\ndata: {"step":2}\r\n',
      "text/event-stream",
    ),
    { step: 2 },
  );
});

test("keeps empty and payload-free responses distinct from malformed JSON", () => {
  assert.equal(parseMcpResponseBody("", null), null);
  assert.equal(parseMcpResponseBody("event: open\ndata:  \n", null), null);
  assert.throws(() => parseMcpResponseBody("data: not-json", null), SyntaxError);
});
