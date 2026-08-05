/**
 * 清除光标所在行及其上方已渲染的行，并把光标放回首行行首。
 * 全程使用光标移动指令，避免换行导致终端内容持续向下滚动。
 */
export function createClearRenderedLinesSequence(lineCount: number): string {
  if (lineCount <= 0) return "";

  const rows = Math.floor(lineCount);
  const moveToFirstLine = rows > 1 ? `\x1b[${rows - 1}A` : "";
  const clearLines = Array.from({ length: rows }, (_, index) =>
    index < rows - 1 ? "\x1b[2K\x1b[1B" : "\x1b[2K",
  ).join("");

  return `\r${moveToFirstLine}${clearLines}${moveToFirstLine}\r`;
}

/** 把 token 数格式化为可读字符串（>=1000 显示 k，如 1234 → 1.2k）。 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000) {
    const value = n / 1000;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)}k`;
  }
  return String(n);
}

/** ANSI 转义序列（如 chalk 生成的 \x1b[31m）。 */
// eslint-disable-next-line no-control-regex -- 有意匹配 ANSI 转义序列（ESC 控制字符）
const ANSI_ESCAPE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * 计算文本在终端上的显示宽度：ANSI 转义不计入列数，
 * CJK/全角字符（中文、日文假名、全角标点等）按 2 列计算，其余按 1 列。
 * 用于在行编辑时把光标精确移动到字符之间。
 */
export function displayWidth(text: string): number {
  const stripped = text.replace(ANSI_ESCAPE, "");
  let width = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0) ?? 0;
    // wcwidth 的宽字符区间（常用子集）
    const isWide =
      (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
      (code >= 0x2e80 && code <= 0x303e) || // CJK 部首/符号
      (code >= 0x3041 && code <= 0x33ff) || // 平假名/片假名/兼容符号
      (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意文字
      (code >= 0xa000 && code <= 0xa4cf) || // 彝文
      (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
      (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意文字
      (code >= 0xfe30 && code <= 0xfe4f) || // CJK 兼容形式
      (code >= 0xff00 && code <= 0xff60) || // 全角形式
      (code >= 0xffe0 && code <= 0xffe6); // 全角符号
    width += isWide ? 2 : 1;
  }
  return width;
}
