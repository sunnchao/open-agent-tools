import * as fs from "node:fs";
import { resolve } from "node:path";

/** 把 LangChain 消息 content（string | 数组）统一转成纯文本。 */
export function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : "text" in c ? (c as { text: string }).text : ""))
      .join("");
  }
  return "";
}

/**
 * 调试用：把发给模型的消息与模型回复写入 debug/ 目录（仅当 DEBUG=1）。
 * 替代了原先 LCEL chain 上的 storeInput/storeOutput 两个 RunnableLambda。
 */
export function dumpLlmIO(promptValue: unknown, response: unknown): void {
  if (!process.env.DEBUG) return;
  const dir = resolve(import.meta.dirname, "./debug");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolve(dir, "last-input.json"), JSON.stringify(promptValue, null, 2));
    fs.writeFileSync(resolve(dir, "last-output.json"), JSON.stringify(response, null, 2));
  } catch {
    // 调试输出失败不应影响主流程
  }
}
