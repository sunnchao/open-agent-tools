import dotenv from "dotenv";

/** 按约定顺序加载环境变量（后加载的可覆盖先前的本地覆盖项）。 */
export function loadEnv(): void {
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.local" });
  dotenv.config({ path: `.env.${process.env.NODE_ENV || "development"}` });
  dotenv.config({ path: `.env.${process.env.NODE_ENV || "development"}.local` });
}

/** 当前 LLM 模型名（OPENAI_API_MODEL 覆盖，默认与 legacy runtime 一致）。 */
export function getModelName(): string {
  return process.env.OPENAI_API_MODEL || "Qwen3.6-35B-A3B";
}

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: readonly PiThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Pi reasoning 级别；默认关闭，避免迁移后无意增加 token 成本。 */
export function getThinkingLevel(): PiThinkingLevel {
  const value = process.env.OPENAI_API_REASONING_EFFORT || "off";
  if (!THINKING_LEVELS.includes(value as PiThinkingLevel)) {
    throw new Error(
      `OPENAI_API_REASONING_EFFORT 无效: ${value}（可选 ${THINKING_LEVELS.join("/")}）`,
    );
  }
  return value as PiThinkingLevel;
}
