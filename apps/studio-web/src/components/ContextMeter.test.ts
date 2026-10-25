import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextMeter, describeCompact } from "./ContextMeter.js";
import type { ChatCompactReport } from "@open-agent-tools/studio-client";

const compact: ChatCompactReport = {
  estimatedTokens: 12_400,
  inputCap: 24_000,
  droppedMessages: 0,
  keptUserTurns: 8,
  toolsTokens: 64,
  ragTruncated: false,
  breakdown: { history: 11_000, rag: 1_300, tools: 64, system: 36 },
};

describe("ContextMeter", () => {
  it("shows estimated usage against the cap", () => {
    const markup = renderToStaticMarkup(createElement(ContextMeter, { compact, onOpen: () => undefined }));
    expect(markup).toContain("约 12.4k / 24k");
    expect(markup).not.toContain("已裁剪");
  });

  it("flags trimmed history", () => {
    const markup = renderToStaticMarkup(
      createElement(ContextMeter, {
        compact: { ...compact, droppedMessages: 72 },
        onOpen: () => undefined,
      }),
    );
    expect(markup).toContain("已裁剪 72 条");
    expect(markup).toContain("ctx-meter--over");
  });

  it("degrades gracefully without a report", () => {
    const markup = renderToStaticMarkup(
      createElement(ContextMeter, { compact: null, onOpen: () => undefined }),
    );
    expect(markup).toContain("上下文 —");
    expect(markup).toContain('aria-label="上下文用量不可用"');
  });

  it("ranks levels by ratio", () => {
    expect(describeCompact({ ...compact, estimatedTokens: 1_000 }).level).toBe("normal");
    expect(describeCompact({ ...compact, estimatedTokens: 18_000 }).level).toBe("warn");
    expect(describeCompact({ ...compact, estimatedTokens: 23_000 }).level).toBe("over");
  });
});
