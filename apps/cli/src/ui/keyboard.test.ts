import assert from "node:assert/strict";
import { it } from "node:test";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { createLineInput } from "./keyboard.ts";
import { displayWidth } from "./terminal.ts";

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

function getInput(rl: readline.Interface): PassThrough {
  return (rl as unknown as { input: PassThrough }).input;
}

it("createLineInput 普通字符输入并在 Enter 后返回文本", async () => {
  const rl = createMockRl();
  const input = getInput(rl);
  const line = createLineInput(rl);
  const promise = line("> ");

  input.write("hello");
  input.write("\r");

  assert.equal(await promise, "hello");
  rl.close();
});

it("←/→ 移动光标后插入到正确位置", async () => {
  const rl = createMockRl();
  const input = getInput(rl);
  const line = createLineInput(rl);
  const promise = line("> ");

  // 光标轨迹：输入 ab（光标在末尾）→ ←←（光标到行首）→ 输入 X（Xab）
  // → →（光标到 X 与 a 之间）→ 输入 Y（XaYb）
  input.write("ab");
  input.write("\x1b[D"); // ←
  input.write("\x1b[D"); // ←
  input.write("X");
  input.write("\x1b[C"); // →
  input.write("Y");
  input.write("\r");

  assert.equal(await promise, "XaYb");
  rl.close();
});

it("↑/↓ 浏览历史，↓ 回到编辑中的草稿", async () => {
  const rl = createMockRl();
  const input = getInput(rl);
  const line = createLineInput(rl);

  const first = line("> ");
  input.write("hello");
  input.write("\r");
  await first;

  const second = line("> ");
  input.write("draft");
  input.write("\x1b[A"); // ↑ 载入 hello
  input.write("\x1b[B"); // ↓ 回到草稿
  input.write("\r");

  assert.equal(await second, "draft");
  rl.close();
});

it("↑ 载入历史后 Enter 直接提交该历史", async () => {
  const rl = createMockRl();
  const input = getInput(rl);
  const line = createLineInput(rl);

  const first = line("> ");
  input.write("hello");
  input.write("\r");
  await first;

  const second = line("> ");
  input.write("\x1b[A"); // ↑ 载入 hello
  input.write("\r");

  assert.equal(await second, "hello");
  rl.close();
});

it("Backspace 删除光标前字符，Delete 删除光标处字符", async () => {
  const rl = createMockRl();
  const input = getInput(rl);
  const line = createLineInput(rl);
  const promise = line("> ");

  input.write("abcd");
  input.write("\x1b[D"); // ← 光标到 c 与 d 之间
  input.write("\x1b[D"); // ← 光标到 b 与 c 之间
  input.write("\x1b[3~"); // delete 删除光标处 c → abd
  input.write("\x1b[D"); // ← 光标到 a 与 b 之间
  input.write("\x7f"); // backspace 删除光标前 a → bd
  input.write("\r");

  assert.equal(await promise, "bd");
  rl.close();
});

it("Home/End 跳转行首/行尾后插入", async () => {
  const rl = createMockRl();
  const input = getInput(rl);
  const line = createLineInput(rl);
  const promise = line("> ");

  input.write("cd");
  input.write("\x1b[H"); // home
  input.write("ab");
  input.write("\x1b[F"); // end
  input.write("ef");
  input.write("\r");

  assert.equal(await promise, "abcdef");
  rl.close();
});

it("Backspace 按码点删除，emoji（代理对）不会被拆散", async () => {
  const rl = createMockRl();
  const input = getInput(rl);
  const line = createLineInput(rl);
  const promise = line("> ");

  // 输入 a👍，Backspace 应删除整个 emoji 而非半个代理对
  input.write("a👍");
  input.write("\x7f");
  input.write("\r");

  assert.equal(await promise, "a");
  rl.close();
});

it("Delete 按码点删除光标处 emoji（代理对）", async () => {
  const rl = createMockRl();
  const input = getInput(rl);
  const line = createLineInput(rl);
  const promise = line("> ");

  // 输入 a👍b，两次 ←：第一次到 b 前，第二次跨过整个 emoji 到其起始处，Delete 删除整个 emoji
  input.write("a👍b");
  input.write("\x1b[D");
  input.write("\x1b[D");
  input.write("\x1b[3~");
  input.write("\r");

  assert.equal(await promise, "ab");
  rl.close();
});

it("←/→ 按码点移动光标，emoji 不会被停在中间", async () => {
  const rl = createMockRl();
  const input = getInput(rl);
  const line = createLineInput(rl);
  const promise = line("> ");

  // 输入 👍a → ←（跳过 a）→ ←（跳过整个 emoji 到行首）→ 插入 X
  input.write("👍a");
  input.write("\x1b[D");
  input.write("\x1b[D");
  input.write("X");
  // → 两次：第一次跨过 emoji 到 a 前，第二次到行尾，插入 Y
  input.write("\x1b[C");
  input.write("\x1b[C");
  input.write("Y");
  input.write("\r");

  assert.equal(await promise, "X👍aY");
  rl.close();
});

it("Ctrl+D 删除光标处字符，空行时忽略", async () => {
  const rl = createMockRl();
  const input = getInput(rl);
  const line = createLineInput(rl);
  const promise = line("> ");

  input.write("\x04"); // 空行 Ctrl+D 应被忽略（不退出）
  input.write("abc");
  input.write("\x1b[D"); // ← 光标到 b 与 c 之间
  input.write("\x04"); // Ctrl+D 删除 c
  input.write("\r");

  assert.equal(await promise, "ab");
  rl.close();
});

it("Ctrl+W 删除光标前一个单词", async () => {
  const rl = createMockRl();
  const input = getInput(rl);
  const line = createLineInput(rl);
  const promise = line("> ");

  input.write("hello world");
  input.write("\x17"); // Ctrl+W
  input.write("\r");

  assert.equal(await promise, "hello ");
  rl.close();
});

it("Alt+Backspace（Option+Delete）删除光标前一个单词", async () => {
  const rl = createMockRl();
  const input = getInput(rl);
  const line = createLineInput(rl);
  const promise = line("> ");

  input.write("foo bar");
  input.write("\x1b\x7f"); // alt+backspace
  input.write("\r");

  assert.equal(await promise, "foo ");
  rl.close();
});

it("Ctrl+K 删除光标到行尾", async () => {
  const rl = createMockRl();
  const input = getInput(rl);
  const line = createLineInput(rl);
  const promise = line("> ");

  input.write("abc");
  input.write("\x1b[D"); // ←
  input.write("\x1b[D"); // ← 光标到 a 与 b 之间
  input.write("\x0b"); // Ctrl+K 删除 bc
  input.write("\r");

  assert.equal(await promise, "a");
  rl.close();
});

it("displayWidth 统计 CJK 双宽字符并忽略 ANSI 转义", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("你好a"), 5);
  assert.equal(displayWidth("\x1b[31mred\x1b[0m"), 3);
});
