import chalk from "chalk";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

const marked = new Marked();

marked.use(
  markedTerminal({
    code: chalk.cyan,
    blockquote: chalk.gray.italic,
    heading: chalk.bold.magenta,
    firstHeading: chalk.bold.underline.magenta,
    strong: chalk.bold,
    em: chalk.italic,
    codespan: chalk.yellow,
    link: chalk.blue.underline,
    href: chalk.blue.underline,
    del: chalk.dim.strikethrough,
    listitem: chalk.reset,
    paragraph: chalk.reset,
    tab: 2,
    reflowText: false,
    // @types/marked-terminal@6 types markedTerminal() as TerminalRenderer,
    // but at runtime it returns a MarkedExtension.
  }) as unknown as Parameters<typeof marked.use>[0],
);

/**
 * 压缩连续空行：3 个及以上换行 → 最多保留 2 个（即段落间只留一行空白）。
 * marked 把 <p> 标签渲染成 \n\n，多段连在一起时容易产生大量多余空行，
 * 这个函数在渲染后统一收口。
 */
function collapseNewlines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

export const renderMarkdown = (source: string): string => {
  if (!source.trim()) return "";
  try {
    return collapseNewlines(String(marked.parse(source, { async: false })).replace(/\s+$/, ""));
  } catch {
    return collapseNewlines(source.replace(/\s+$/, ""));
  }
};

// ---- 流式渲染 ----
let _renderBuffer = "";
let _lastRendered = "";

/**
 * 流式 markdown 渲染器（用于 onToken 回调）。
 * 每次新 token 到来时，累积 buffer 并重新渲染整段内容。
 * 返回完整渲染结果，调用方负责输出。
 *
 * 注意：marked-terminal 输出的 ANSI 颜色代码可能让渲染结果比纯文本长，
 * 导致 \r 清行时残留旧行尾的 ANSI 字符。调用方应使用 ESC[2K\r 清行再输出。
 */
export function renderMarkdownStream(token: string): string {
  if (!token) return "";
  _renderBuffer += token;
  try {
    const rendered = collapseNewlines(
      String(marked.parse(_renderBuffer, { async: false })).replace(/\s+$/, ""),
    );
    _lastRendered = rendered;
    return rendered;
  } catch {
    // marked 对残缺 markdown（如未闭合代码块）一般不抛错，仅作兜底。
    // 注意：token 已在 try 前追加过，这里不能再追加，否则会重复。
    return _lastRendered || _renderBuffer;
  }
}

/** 重置流式 buffer（新回复开始时调用）。 */
export function resetMarkdownStream(): void {
  _renderBuffer = "";
  _lastRendered = "";
}
