export const DEFAULT_RAG_SEPARATORS = ["\n\n", "\n", "。", "！", "？", ". ", " "];

export function separatorsToText(separators: readonly string[]): string {
  return separators
    .map((separator) =>
      separator
        .replaceAll("\\", "\\\\")
        .replaceAll("\n", "\\n")
        .replaceAll("\r", "\\r")
        .replaceAll("\t", "\\t")
        .replaceAll(" ", "\\s"),
    )
    .join("\n");
}

export function separatorsFromText(value: string): string[] {
  const separators = value
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) =>
      line.replace(/\\(\\|n|r|t|s)/g, (_match, escape: string) => {
        if (escape === "n") return "\n";
        if (escape === "r") return "\r";
        if (escape === "t") return "\t";
        if (escape === "s") return " ";
        return "\\";
      }),
    );
  return separators.filter((separator, index) => separators.indexOf(separator) === index);
}

export function validateSeparators(separators: readonly string[]): string | null {
  if (separators.length === 0) return "请至少配置一个分段标识符";
  if (separators.length > 20) return "分段标识符不能超过 20 个";
  if (separators.some((separator) => Array.from(separator).length > 32)) {
    return "单个分段标识符不能超过 32 个字符";
  }
  return null;
}
