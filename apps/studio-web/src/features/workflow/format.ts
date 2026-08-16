export function formatNodeTestDuration(durationMs: number): string {
  return `${(Math.max(0, durationMs) / 1000).toFixed(3)}s`;
}

export function formatNodeTestTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
