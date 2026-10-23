export function httpErrorStatus(error: unknown): 400 | 404 {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("not found") ? 404 : 400;
}
