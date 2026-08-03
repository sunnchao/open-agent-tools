import { SYSTEM_PROMPT } from "./systemPrompt.ts";
import { CONTEXT_FILE_NAME } from "../store/context.ts";
import { MemoryStore, buildMemoryContext } from "../store/memory.ts";

export interface BuildSystemPromptOptions {
  projectContext: string | null;
  memoryStore: MemoryStore;
  taskHint: string;
}

/** 组合系统提示词：基础 prompt + 项目上下文 + 当前任务相关的已审核长期记忆。 */
export function buildSystemPrompt(opts: BuildSystemPromptOptions): string {
  let prompt = SYSTEM_PROMPT;
  if (opts.projectContext) {
    prompt +=
      `\n\n## 项目上下文（由 /init 生成，已保存在仓库根目录 ${CONTEXT_FILE_NAME}，你可手动补充）\n` +
      opts.projectContext;
  }
  const memoryContext = buildMemoryContext(opts.memoryStore, opts.taskHint, {
    limit: 8,
    maxChars: 6_000,
  });
  if (memoryContext) prompt += `\n\n${memoryContext}`;
  return prompt;
}
