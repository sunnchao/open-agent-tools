import { describe, expect, it } from "vitest";
import { consumeSse, parseSseBuffer } from "./sse";

describe("parseSseBuffer", () => {
  it("splits events and keeps the tail", () => {
    const { events, rest } = parseSseBuffer(
      'data: {"delta":"hi"}\n\ndata: {"done":true}\n\npartial',
    );
    expect(events).toEqual([{ delta: "hi" }, { done: true }]);
    expect(rest).toBe("partial");
  });
  it("merges multiline data fields", () => {
    const { events } = parseSseBuffer('event: msg\ndata: {"a":\ndata: 1}\n\n');
    expect(events).toEqual([{ a: 1 }]);
  });
});

describe("consumeSse", () => {
  it("reads a web ReadableStream body", async () => {
    const text = 'data: {"delta":"a"}\n\ndata: {"done":true}\n\n';
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
    const seen: Array<Record<string, unknown>> = [];
    await consumeSse({ body: stream } as unknown as Response, (e) => {
      seen.push(e);
      return e.done === true;
    });
    expect(seen).toEqual([{ delta: "a" }, { done: true }]);
  });
  it("falls back to text() when no reader exists", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await consumeSse(
      { body: null, text: async () => 'data: {"done":true}\n\n' } as unknown as Response,
      (e) => {
        seen.push(e);
        return true;
      },
    );
    expect(seen).toEqual([{ done: true }]);
  });
});
