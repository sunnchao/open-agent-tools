import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { renderMarkdownStream, resetMarkdownStream } from "./markdown.ts";

describe("renderMarkdownStream", () => {
  afterEach(() => resetMarkdownStream());

  it("renders short text without extra lines", () => {
    const rendered = stripVTControlCharacters(renderMarkdownStream("测试 markdown"));

    assert.equal(rendered, "测试 markdown");
  });

  it("does not repeat content after the stream is reset", () => {
    renderMarkdownStream("第一段");
    resetMarkdownStream();

    const rendered = stripVTControlCharacters(renderMarkdownStream("第二段"));
    assert.equal(rendered, "第二段");
  });
});
