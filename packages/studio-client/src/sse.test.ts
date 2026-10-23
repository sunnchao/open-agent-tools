import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeSse, parseSseBuffer } from "./sse.js";

test("SSE 兼容 LF、CRLF、多行 data、注释及跨块分隔符", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const text = [
      ": keepalive",
      "event: message",
      'data: {"delta":',
      'data: "你好"}',
      "",
      'data: {"done":true}',
      "",
      "",
    ].join(newline);
    assert.deepEqual(parseSseBuffer(text).events, [{ delta: "你好" }, { done: true }]);
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 每次仅一个字节，覆盖 UTF-8 字符和 CRLF 被拆到不同块。
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    const events: Record<string, unknown>[] = [];
    await consumeSse(new Response(stream), (event) => {
      events.push(event);
    });
    assert.deepEqual(events, [{ delta: "你好" }, { done: true }]);
    assert.equal(stream.locked, false);
  }
});

test("SSE 业务终止只分发一次，并取消、释放流", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('data: {"done":true}\n\ndata: {"done":true}\n\n'),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  let count = 0;
  await consumeSse(new Response(stream), () => {
    count++;
    return true;
  });
  assert.equal(count, 1);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("SSE 回调异常和连接中止后释放 reader", async () => {
  for (const abort of [false, true]) {
    const failure = abort
      ? new DOMException("Stopped", "AbortError")
      : new Error("callback failure");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(new TextEncoder().encode('data: {"delta":"a"}\n\n'));
      },
    });
    await assert.rejects(
      consumeSse(new Response(stream), () => {
        if (abort) controller.error(failure);
        else throw failure;
      }),
      failure,
    );
    assert.equal(stream.locked, false);
  }
});

test("SSE text 降级与 stream 一致，支持末尾未带空行的事件", async () => {
  const text = 'data: {"delta":"a"}\r\n\r\ndata: {"done":true}';
  const seen: Record<string, unknown>[] = [];
  await consumeSse({ body: null, text: async () => text } as Response, (event) => {
    seen.push(event);
  });
  assert.deepEqual(seen, [{ delta: "a" }, { done: true }]);
  assert.deepEqual(parseSseBuffer('data: invalid\n\ndata: {"ok":true}\n\npartial'), {
    events: [{ ok: true }],
    rest: "partial",
  });
});
