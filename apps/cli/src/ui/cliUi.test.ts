import assert from "node:assert/strict";
import { it } from "node:test";
import { createMenuSelect, createConfirm } from "./cliUi.ts";
import readline from "node:readline";
import { PassThrough } from "node:stream";

/** 模拟一个能触发 keypress 事件的 readline 接口。 */
function createMockRl(): readline.Interface {
  const input = new PassThrough();
  // 非 TTY 输入默认不触发 keypress，需显式开启
  readline.emitKeypressEvents(input);
  const rl = readline.createInterface({
    input,
    output: { write: () => {} } as unknown as NodeJS.WritableStream,
  });
  return rl;
}

it("createMenuSelect 用 ↑/↓ 切换、Enter 确认，不依赖输入文字", async () => {
  const rl = createMockRl();
  const input = (rl as unknown as { input: PassThrough }).input;
  const select = createMenuSelect(rl);
  const promise = select("标题", ["允许", "拒绝", "始终允许"]);

  // 模拟按一次 ↓（切换到“拒绝”）
  input.write("\x1b[B");
  // 模拟按 Enter 确认
  input.write("\r");

  const index = await promise;
  assert.equal(index, 1);
  rl.close();
});

it("createConfirm 菜单选择映射到 PermissionDecision", async () => {
  const rl = createMockRl();
  const input = (rl as unknown as { input: PassThrough }).input;
  const confirm = createConfirm(rl);
  const p = confirm("execute", "pwd && ls -la");

  // 模拟按 ↓（到“拒绝”）再按 ↑（回到“允许”）再按 Enter
  input.write("\x1b[B");
  input.write("\x1b[A");
  input.write("\r");

  const decision = await p;
  assert.equal(decision, "allow");
  rl.close();
});
