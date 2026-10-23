export type ConnectorSyncStatus = "idle" | "success" | "partial" | "error";

/** Human-readable connector state shared by the web and native clients. */
export function connectorStatusLabel(status: ConnectorSyncStatus | null): string {
  if (status === "success") return "成功";
  if (status === "partial") return "部分成功";
  if (status === "error") return "失败";
  return "未同步";
}

/** Employee entry hash shared by published-app administration and native links. */
export function employeeEntryPath(slug: string, accessToken?: string | null): string {
  const base = `#/app/${slug}`;
  return accessToken ? `${base}?access_token=${encodeURIComponent(accessToken)}` : base;
}

export function linesToPatterns(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function patternsToText(patterns: string[]): string {
  return patterns.join("\n");
}
