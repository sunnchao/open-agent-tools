import assert from "node:assert/strict";
import { test } from "node:test";
import { getThinkingLevel } from "./env.ts";

test("thinking level 默认关闭并接受 Pi 支持的级别", () => {
  const previous = process.env.OPENAI_API_REASONING_EFFORT;
  try {
    delete process.env.OPENAI_API_REASONING_EFFORT;
    assert.equal(getThinkingLevel(), "off");
    process.env.OPENAI_API_REASONING_EFFORT = "medium";
    assert.equal(getThinkingLevel(), "medium");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_REASONING_EFFORT;
    else process.env.OPENAI_API_REASONING_EFFORT = previous;
  }
});

test("thinking level 对无效配置 fail-fast", () => {
  const previous = process.env.OPENAI_API_REASONING_EFFORT;
  try {
    process.env.OPENAI_API_REASONING_EFFORT = "extreme";
    assert.throws(() => getThinkingLevel(), /OPENAI_API_REASONING_EFFORT 无效/);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_REASONING_EFFORT;
    else process.env.OPENAI_API_REASONING_EFFORT = previous;
  }
});
