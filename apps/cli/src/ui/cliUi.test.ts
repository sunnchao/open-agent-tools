import assert from "node:assert/strict";
import { it } from "node:test";
import { createMenuSelect, createConfirm, createSlashCommandPicker } from "./cliUi.ts";
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

it("createMenuSelect Esc 取消返回 -1", async () => {
  const rl = createMockRl();
  const input = (rl as unknown as { input: PassThrough }).input;
  const select = createMenuSelect(rl);
  const promise = select("标题", ["允许", "拒绝"]);

  input.write("\x1b");

  const index = await promise;
  assert.equal(index, -1);
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

it("createSlashCommandPicker 用 ↑/↓ 选择无参命令", async () => {
  const rl = createMockRl();
  const input = (rl as unknown as { input: PassThrough }).input;
  const pick = createSlashCommandPicker(rl);
  const promise = pick("/he");

  // 过滤后通常只有 /help；直接 Enter
  input.write("\r");

  const selected = await promise;
  assert.equal(selected, "/help");
  rl.close();
});

it("createSlashCommandPicker 选择后补充参数", async () => {
  const rl = createMockRl();
  const input = (rl as unknown as { input: PassThrough }).input;
  const pick = createSlashCommandPicker(rl);
  const promise = pick("/load");

  // 过滤命中 /load，Enter 确认
  input.write("\r");
  // 参数输入：会话 id + Enter
  setTimeout(() => {
    input.write("abc12345");
    input.write("\r");
  }, 10);

  const selected = await promise;
  assert.equal(selected, "/load abc12345");
  rl.close();
});
