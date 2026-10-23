/**
 * Parse an MCP HTTP response body. Upstreams may return JSON directly or SSE
 * whose final non-empty `data:` line contains the JSON-RPC payload.
 */
export function parseMcpResponseBody(text: string, contentType: string | null): unknown {
  if (text.length === 0) return null;
  if (
    contentType?.includes("text/event-stream") ||
    text.startsWith("event:") ||
    text.startsWith("data:")
  ) {
    const payloads = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((line) => line.length > 0);
    if (payloads.length === 0) return null;
    return JSON.parse(payloads[payloads.length - 1]!);
  }
  return JSON.parse(text);
}
