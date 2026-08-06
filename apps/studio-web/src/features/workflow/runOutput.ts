export function formatWorkflowRunOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    const formatted = JSON.stringify(value, null, 2);
    return formatted === undefined ? String(value) : formatted;
  } catch {
    return String(value);
  }
}
