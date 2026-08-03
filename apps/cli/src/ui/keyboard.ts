import readline from "node:readline";
import { displayWidth } from "./terminal.ts";

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * 光标前一个完整 Unicode 码点的起始 UTF-16 索引。
 * 避免按 UTF-16 码元删除时拆散 emoji 等代理对字符（光标在 0 时返回 0）。
 */
function previousCodePointStart(text: string, cursor: number): number {
  if (cursor <= 0) return 0;
  if (isLowSurrogate(text.charCodeAt(cursor - 1)) && isHighSurrogate(text.charCodeAt(cursor - 2))) {
    return cursor - 2;
  }
  return cursor - 1;
}

/** 光标处完整 Unicode 码点的结束 UTF-16 索引（不含）。 */
function nextCodePointEnd(text: string, cursor: number): number {
  if (isHighSurrogate(text.charCodeAt(cursor)) && isLowSurrogate(text.charCodeAt(cursor + 1))) {
    return cursor + 2;
  }
  return cursor + 1;
}

/** 光标前一个单词（空白分隔）的起始 UTF-16 索引，供 Ctrl+W / Alt+Backspace 使用。 */
function wordStartBefore(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(text[i - 1] ?? "")) i -= 1;
  while (i > 0 && !/\s/.test(text[i - 1] ?? "")) i -= 1;
  return i;
}

/** keypress 事件回调里的按键描述（readline 解析后的形状）。 */
export interface KeypressKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** 输入流需要支持 keypress 事件与 raw 模式切换。 */
export type KeypressStream = NodeJS.ReadableStream & {
  on(event: "keypress", listener: (str: string, key: KeypressKey) => void): void;
  removeListener(event: "keypress", listener: (str: string, key: KeypressKey) => void): void;
  setRawMode?: (mode: boolean) => void;
};

/** 从 readline 接口取底层输入流（@types/node 未将其列为公开属性，需断言）。 */
export function getKeypressStream(rl: readline.Interface): KeypressStream {
  return (rl as unknown as { input: NodeJS.ReadableStream }).input as unknown as KeypressStream;
}

/**
 * 开启输入流的 keypress 事件与 raw 模式并挂上 onKey 监听。
 * 必须监听输入流本身的 keypress 事件（rl.on("keypress") 在真实 TTY 上不会触发），
 * 返回的 close 函数会移除监听并恢复行模式，避免影响后续行输入。
 */
export function openKeypress(
  rl: readline.Interface,
  onKey: (str: string, key: KeypressKey) => void,
): () => void {
  const input = getKeypressStream(rl);
  readline.emitKeypressEvents(input);
  if (input.setRawMode) input.setRawMode(true);
  input.on("keypress", onKey);
  return () => {
    if (input.setRawMode) input.setRawMode(false);
    input.removeListener("keypress", onKey);
  };
}

/** raw 模式下 Ctrl+C 不会产生 SIGINT：先关闭会话再重新触发，保持原有退出行为。 */
export function triggerSigint(close: () => void): void {
  close();
  process.kill(process.pid, "SIGINT");
}

export interface LineInputOptions {
  /** 初始历史记录；每次提交后会自动追加。 */
  history?: string[];
}

/**
 * 支持方向键的行输入：
 * ←/→ 在行内移动光标（按 Unicode 码点移动，emoji 不会被拆开），↑/↓ 浏览历史（最近一条开始，
 * ↓ 回到编辑中的草稿），Home/End（或 Ctrl+A/Ctrl+E）跳转行首/行尾，
 * Backspace 删除光标前字符，Delete（或 Ctrl+D）删除光标处字符，
 * Ctrl+W / Alt+Backspace 删除光标前一个单词，Ctrl+U 清空光标前文本，Ctrl+K 删除到行尾。
 * 返回的函数每次调用开启一次输入会话，历史记录在多次调用间共享。
 */
export function createLineInput(
  rl: readline.Interface,
  options: LineInputOptions = {},
): (prompt: string) => Promise<string> {
  const history: string[] = options.history ?? [];

  return (prompt) =>
    new Promise<string>((resolve) => {
      let text = "";
      let cursor = 0;
      // history.length 表示「正在编辑草稿」的位置，↑ 从最近一条历史开始
      let historyIndex = history.length;
      let draft = "";
      let close: () => void = () => {};

      const isEnter = (key: KeypressKey): boolean =>
        key.name === "return" || key.sequence === "\r" || key.sequence === "\n";

      const isArrow = (key: KeypressKey, name: string, sequence: string): boolean =>
        key.name === name || key.sequence === sequence;

      const render = (): void => {
        // 整行重绘：回到行首清行 → 写 prompt+文本 → 按后缀宽度把光标移回插入位置
        process.stdout.write(`\r\x1b[2K${prompt}${text}`);
        const suffixWidth = displayWidth(text.slice(cursor));
        if (suffixWidth > 0) process.stdout.write(`\x1b[${suffixWidth}D`);
      };

      const insertText = (value: string): void => {
        text = text.slice(0, cursor) + value + text.slice(cursor);
        cursor += value.length;
        render();
      };

      const historyUp = (): void => {
        if (historyIndex === 0) return;
        if (historyIndex === history.length) draft = text;
        historyIndex -= 1;
        text = history[historyIndex] ?? "";
        cursor = text.length;
        render();
      };

      const historyDown = (): void => {
        if (historyIndex === history.length) return;
        historyIndex += 1;
        text = historyIndex === history.length ? draft : (history[historyIndex] ?? "");
        cursor = text.length;
        render();
      };

      const submit = (): void => {
        close();
        process.stdout.write("\n");
        const trimmed = text.trim();
        if (trimmed && history[history.length - 1] !== text) history.push(text);
        resolve(text);
      };

      /** 删除光标前一个完整码点；光标停在代理对中间时连同其后的低代理一起删除。 */
      const deleteCharBefore = (): void => {
        if (cursor <= 0) return;
        const start = previousCodePointStart(text, cursor);
        let end = cursor;
        if (isLowSurrogate(text.charCodeAt(end)) && isHighSurrogate(text.charCodeAt(end - 1))) {
          end += 1;
        }
        text = text.slice(0, start) + text.slice(end);
        cursor = start;
        render();
      };

      /** 删除光标处完整码点；光标停在代理对中间时连同其前的高代理一起删除。 */
      const deleteCharAt = (): void => {
        if (cursor >= text.length) return;
        let start = cursor;
        let fixed = false;
        if (
          isLowSurrogate(text.charCodeAt(start)) &&
          start > 0 &&
          isHighSurrogate(text.charCodeAt(start - 1))
        ) {
          start -= 1;
          fixed = true;
        }
        const end = nextCodePointEnd(text, start);
        text = text.slice(0, start) + text.slice(end);
        if (fixed) cursor = start;
        render();
      };

      /** 删除光标前一个单词（空白分隔）。 */
      const deleteWordBefore = (): void => {
        const start = wordStartBefore(text, cursor);
        if (start < cursor) {
          text = text.slice(0, start) + text.slice(cursor);
          cursor = start;
          render();
        }
      };

      /** 删除光标到行尾。 */
      const deleteToEnd = (): void => {
        if (cursor < text.length) {
          text = text.slice(0, cursor);
          render();
        }
      };

      const onKey = (_str: string, key: KeypressKey): void => {
        if (key.ctrl && key.name === "c") {
          triggerSigint(close);
        } else if (isEnter(key)) {
          submit();
        } else if (isArrow(key, "up", "\x1b[A")) {
          historyUp();
        } else if (isArrow(key, "down", "\x1b[B")) {
          historyDown();
        } else if (isArrow(key, "left", "\x1b[D")) {
          if (cursor > 0) {
            cursor = previousCodePointStart(text, cursor);
            render();
          }
        } else if (isArrow(key, "right", "\x1b[C")) {
          if (cursor < text.length) {
            cursor = nextCodePointEnd(text, cursor);
            render();
          }
        } else if (
          key.name === "home" ||
          key.sequence === "\x1b[H" ||
          (key.ctrl && key.name === "a")
        ) {
          if (cursor !== 0) {
            cursor = 0;
            render();
          }
        } else if (
          key.name === "end" ||
          key.sequence === "\x1b[F" ||
          (key.ctrl && key.name === "e")
        ) {
          if (cursor !== text.length) {
            cursor = text.length;
            render();
          }
        } else if (key.meta && key.name === "backspace") {
          // Alt/Option+Backspace：删除光标前一个单词
          deleteWordBefore();
        } else if (key.ctrl && key.name === "w") {
          // Ctrl+W：删除光标前一个单词
          deleteWordBefore();
        } else if (key.ctrl && key.name === "k") {
          // Ctrl+K：删除光标到行尾
          deleteToEnd();
        } else if (key.name === "backspace" || key.sequence === "\x7f") {
          deleteCharBefore();
        } else if (
          key.name === "delete" ||
          key.sequence === "\x1b[3~" ||
          (key.ctrl && key.name === "d")
        ) {
          // Delete / Ctrl+D：删除光标处字符（空行时忽略，避免误触发退出）
          deleteCharAt();
        } else if (key.ctrl && key.name === "u") {
          if (cursor > 0 || text.length > 0) {
            text = text.slice(cursor);
            cursor = 0;
            render();
          }
        } else if (key.name === "space") {
          insertText(" ");
        } else if (key.name === "tab") {
          insertText("\t");
        } else if (key.sequence && !key.ctrl && !key.meta && !key.sequence.startsWith("\x1b")) {
          // 可打印字符：readline 对 ASCII 字符的 name 为字符本身，
          // 对 emoji/CJK 等非 ASCII 字符 name 为 undefined，统一按 sequence 插入；
          // 以 \x1b 开头的未识别转义序列（如 F 键）不在此列
          insertText(key.sequence);
        }
      };

      close = openKeypress(rl, onKey);
      render();
    });
}
