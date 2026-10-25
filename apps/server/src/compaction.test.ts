import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCompactReport,
  capText,
  compactConversation,
  estimateMessageTokens,
  estimateTokens,
  resolveCompactionBudget,
  type CompactionBudget,
} from "./compaction.js";

const budget: CompactionBudget = {
  inputCap: 200,
  reserveOutput: 50,
  keepRecentTurns: 2,
  ragMaxChars: 100,
  toolResultMaxChars: 100,
};

function longTurn(index: number): Array<{ role: string; content: string }> {
  return [
    { role: "user", content: `问题${index} ${"请回答".repeat(20)}` },
    { role: "assistant", content: `回答${index} ${"好的".repeat(20)}` },
  ];
}

describe("estimateTokens", () => {
  it("returns 0 for empty text", () => {
    assert.equal(estimateTokens(""), 0);
  });

  it("counts ascii at ~4 chars per token with margin", () => {
    assert.equal(estimateTokens("helloworld"), Math.ceil((10 / 4) * 1.2));
  });

  it("counts CJK heavier than ascii", () => {
    assert.ok(estimateTokens("你好世界") > estimateTokens("helloworld".slice(0, 4)));
  });
});

describe("resolveCompactionBudget", () => {
  it("falls back to defaults on missing or invalid env", () => {
    const previous = process.env.CHAT_INPUT_CAP;
    delete process.env.CHAT_INPUT_CAP;
    try {
      assert.equal(resolveCompactionBudget().inputCap, 24_000);
      process.env.CHAT_INPUT_CAP = "not-a-number";
      assert.equal(resolveCompactionBudget().inputCap, 24_000);
      process.env.CHAT_INPUT_CAP = "-5";
      assert.equal(resolveCompactionBudget().inputCap, 24_000);
    } finally {
      if (previous === undefined) delete process.env.CHAT_INPUT_CAP;
      else process.env.CHAT_INPUT_CAP = previous;
    }
  });

  it("honors explicit env overrides", () => {
    const previous = process.env.CHAT_KEEP_RECENT_TURNS;
    process.env.CHAT_KEEP_RECENT_TURNS = "5";
    try {
      assert.equal(resolveCompactionBudget().keepRecentTurns, 5);
    } finally {
      if (previous === undefined) delete process.env.CHAT_KEEP_RECENT_TURNS;
      else process.env.CHAT_KEEP_RECENT_TURNS = previous;
    }
  });
});

describe("capText", () => {
  it("passes short text through untouched", () => {
    assert.deepEqual(capText("abc", 10, "[截断]"), { text: "abc", truncated: false });
  });

  it("truncates with an explicit marker", () => {
    const result = capText("abcdef", 4, "[截断]");
    assert.equal(result.truncated, true);
    assert.equal(result.text, "abcd[截断]");
  });
});

describe("compactConversation", () => {
  it("keeps everything when under budget", () => {
    const messages = [
      { role: "system", content: "系统提示" },
      ...longTurn(1).slice(0, 1),
    ];
    const result = compactConversation(messages, { ...budget, inputCap: 100_000 });
    assert.equal(result.droppedMessages, 0);
    assert.deepEqual(result.messages, messages);
  });

  it("always preserves system messages and newest turns first", () => {
    const messages = [
      { role: "system", content: "系统提示" },
      ...longTurn(1),
      ...longTurn(2),
      ...longTurn(3),
    ];
    const result = compactConversation(messages, budget);
    assert.ok(result.droppedMessages > 0);
    assert.equal(result.messages[0]!.role, "system");
    const contents = result.messages.map((message) => message.content).join("\n");
    assert.ok(contents.includes("问题3"));
    assert.ok(!contents.includes("问题1"));
  });

  it("guarantees keepRecentTurns user turns even over budget", () => {
    const messages = [...longTurn(1), ...longTurn(2), ...longTurn(3)];
    const result = compactConversation(messages, { ...budget, inputCap: 1 });
    assert.equal(result.keptUserTurns, 2);
    const contents = result.messages.map((message) => message.content).join("\n");
    assert.ok(contents.includes("问题3") && contents.includes("问题2"));
  });

  it("reserves tool-definition tokens from the budget", () => {
    const messages = [...longTurn(1)];
    const without = compactConversation(messages, { ...budget, inputCap: 100_000 });
    const withReserve = compactConversation(messages, { ...budget, inputCap: 100_000 }, { reservedTokens: 99_999 });
    assert.equal(without.droppedMessages, 0);
    assert.ok(withReserve.estimatedTokens > without.estimatedTokens);
  });

  it("passes through extra fields like tool_calls untouched", () => {
    const messages = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", name: "search", arguments: "{}" }],
      },
    ];
    const result = compactConversation(messages, { ...budget, inputCap: 100_000 });
    assert.deepEqual(result.messages, messages);
  });
});

describe("buildCompactReport", () => {
  it("splits segments that sum back to the estimate", () => {
    const ragContent = "RAG注入".repeat(10);
    const messages = [{ role: "system", content: ragContent }, ...longTurn(1)];
    const compacted = compactConversation(messages, { ...budget, inputCap: 100_000 }, { reservedTokens: 10 });
    const report = buildCompactReport({
      compacted,
      budget,
      toolsTokens: 10,
      ragTokens: estimateMessageTokens("system", ragContent),
      ragTruncated: true,
    });
    const { history, rag, tools, system } = report.breakdown;
    assert.equal(history + rag + tools + system, report.estimatedTokens);
    assert.equal(tools, 10);
    assert.equal(report.ragTruncated, true);
    assert.equal(report.inputCap, budget.inputCap);
  });
});
