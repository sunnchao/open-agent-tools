import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageTag } from "./UsageTag.js";
import type { MessageUsage } from "../types.js";

const usage: MessageUsage = {
  requests: 3,
  inputTokens: 1000,
  outputTokens: 250,
  totalTokens: 1250,
  toolCalls: 2,
  toolErrors: 1,
};

describe("usage display", () => {
  it("shows requests, exact token counts and tool failures with input/output details", () => {
    const markup = renderToStaticMarkup(createElement(UsageTag, { usage }));
    expect(markup).toContain("模型请求 3 次");
    expect(markup).toContain("1,250 tokens");
    expect(markup).toContain("输入 1,000 · 输出 250");
    expect(markup).toContain("工具 2 次（1 失败）");
  });

  it("shows calls with missing token metadata and zero-cost retrieval", () => {
    for (const requests of [0, 1]) {
      const markup = renderToStaticMarkup(
        createElement(UsageTag, {
          usage: {
            requests,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            toolCalls: 0,
            toolErrors: 0,
          },
        }),
      );
      expect(markup).toContain(`模型请求 ${requests} 次`);
      expect(markup).toContain("0 tokens");
    }
  });

  it("keeps historic usage visible without inventing an unknown request count", () => {
    const { requests: _requests, ...historical } = usage;
    const markup = renderToStaticMarkup(createElement(UsageTag, { usage: historical }));
    expect(markup).toContain("1,250 tokens");
    expect(markup).not.toContain("模型请求");
    expect(renderToStaticMarkup(createElement(UsageTag, {}))).toBe("");
  });
});
