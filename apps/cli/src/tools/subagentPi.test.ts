import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent";
import {
  createSubagentPiTool,
  READ_ONLY_SUBAGENT_TOOLS,
  runIsolatedSubagent,
  type IsolatedSubagentSession,
} from "./subagentPi.ts";

function fakeSession(
  prompt: (session: IsolatedSubagentSession, input: string) => Promise<void>,
): IsolatedSubagentSession & { disposed: boolean; aborted: number } {
  const listeners = new Set<AgentSessionEventListener>();
  const session: IsolatedSubagentSession & { disposed: boolean; aborted: number } = {
    messages: [],
    disposed: false,
    aborted: 0,
    prompt: (input) => prompt(session, input),
    abort: async () => {
      session.aborted += 1;
    },
    dispose: () => {
      session.disposed = true;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  Object.assign(session, {
    emit: (event: AgentSessionEvent) => listeners.forEach((listener) => listener(event)),
  });
  return session;
}

test("task 使用空白子会话并只回传最终报告", async () => {
  let initialMessageCount = -1;
  let receivedPrompt = "";
  const session = fakeSession(async (child, input) => {
    initialMessageCount = child.messages.length;
    receivedPrompt = input;
    (child.messages as Array<{ role: string; content?: unknown }>).push(
      { role: "user", content: receivedPrompt },
      { role: "assistant", content: [{ type: "text", text: "发现一处遗漏" }] },
    );
  });

  const result = await runIsolatedSubagent("检查迁移遗漏", undefined, {
    createSession: async () => session,
  });

  assert.equal(initialMessageCount, 0, "子会话不应继承父会话历史");
  assert.equal(receivedPrompt, "检查迁移遗漏");
  assert.equal(result, "发现一处遗漏");
  assert.equal(session.disposed, true);
});

test("task 汇总子会话 usage 并在取消后 abort/dispose", async () => {
  const controller = new AbortController();
  const reported: unknown[] = [];
  const session = fakeSession(async (child) => {
    const emit = (child as IsolatedSubagentSession & { emit: (event: AgentSessionEvent) => void })
      .emit;
    emit({
      type: "turn_end",
      message: {
        role: "assistant",
        usage: { input: 12, output: 3, reasoning: 2 },
      },
    } as AgentSessionEvent);
    emit({
      type: "compaction_end",
      reason: "threshold",
      result: { usage: { input: 5, output: 1, reasoning: 0 } },
      aborted: false,
      willRetry: false,
    } as AgentSessionEvent);
    controller.abort();
  });

  await assert.rejects(
    runIsolatedSubagent("长任务", controller.signal, {
      createSession: async () => session,
      onUsage: (usage) => reported.push(usage),
    }),
    { name: "AbortError" },
  );
  assert.equal(session.aborted, 1);
  assert.equal(session.disposed, true);
  assert.deepEqual(reported, [{ inputTokens: 17, outputTokens: 4, reasoningTokens: 2 }]);
});

test("task 工具保持 legacy 名称且子代理白名单不含危险工具", () => {
  assert.deepEqual(READ_ONLY_SUBAGENT_TOOLS, ["read", "grep", "find", "ls"]);
  for (const dangerous of ["write", "edit", "bash", "task"]) {
    assert.equal(READ_ONLY_SUBAGENT_TOOLS.includes(dangerous as never), false);
  }

  const tool = createSubagentPiTool({
    createSession: async () => {
      throw new Error("not called");
    },
  });
  assert.equal(tool.name, "task");
  assert.equal(tool.executionMode, "parallel");
});
