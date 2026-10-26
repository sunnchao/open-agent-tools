export interface PromptHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** Format recent conversation turns for prompts while preserving their stored content. */
export function formatHistoryText(history: readonly PromptHistoryTurn[], limit?: number): string {
  const visible = limit === undefined ? history : history.slice(-limit);
  return visible
    .map((turn) => `${turn.role === "user" ? "用户" : "助手"}: ${turn.content}`)
    .join("\n");
}
