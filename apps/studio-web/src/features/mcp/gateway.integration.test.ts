import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callGatewayTool, type GatewayToolCall } from "./gateway.js";

const input: GatewayToolCall = {
  serviceSlug: "web search",
  apiKey: "  mcp.secret  ",
  toolName: "web_search",
  arguments: { query: "MCP transports" },
};
const result = { content: [{ type: "text", text: "done" }] };

interface RpcRequest {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

describe("MCP Gateway client with the real SDK", () => {
  const requests: RpcRequest[] = [];
  const networkFetch = vi.fn<typeof fetch>();

  beforeEach(() => {
    requests.length = 0;
    vi.stubGlobal("window", { location: { origin: "http://studio.local" } });
    vi.stubGlobal("fetch", networkFetch);
    networkFetch.mockReset().mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return new Response(null, { status: 405 });

      const request = JSON.parse(init?.body as string) as RpcRequest;
      requests.push(request);
      if (request.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "gateway-test", version: "1.0.0" },
              }
            : result,
      });
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("initializes and calls the Tool using only POST requests to the stateless Gateway", async () => {
    await expect(callGatewayTool(input)).resolves.toEqual(result);

    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(requests[2]?.params).toEqual({
      name: "web_search",
      arguments: input.arguments,
    });
    expect(networkFetch).toHaveBeenCalledTimes(3);
    for (const [url, init] of networkFetch.mock.calls) {
      expect(url.toString()).toBe("http://studio.local/mcp/services/web%20search");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mcp.secret");
      expect(init?.signal?.aborted).toBe(true);
    }
  });

  it("propagates POST authentication failures and closes the transport", async () => {
    networkFetch.mockResolvedValue(
      Response.json({ error: { message: "Unauthorized" } }, { status: 401 }),
    );

    await expect(callGatewayTool(input)).rejects.toMatchObject({
      code: 401,
      message: expect.stringContaining("Unauthorized"),
    });
    expect(networkFetch).toHaveBeenCalledOnce();
    expect(networkFetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("propagates POST Tool failures and closes the transport", async () => {
    const respond = networkFetch.getMockImplementation()!;
    networkFetch.mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        const request = JSON.parse(init.body as string) as RpcRequest;
        if (request.method === "tools/call") {
          return Response.json(
            { error: { message: "Tool execution unavailable" } },
            { status: 503 },
          );
        }
      }
      return respond(url, init);
    });

    await expect(callGatewayTool(input)).rejects.toMatchObject({
      code: 503,
      message: expect.stringContaining("Tool execution unavailable"),
    });
    expect(networkFetch.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
  });

  it("rejects an empty API key before making a network request", async () => {
    await expect(callGatewayTool({ ...input, apiKey: "  " })).rejects.toThrow(
      "请输入 Gateway API Key",
    );
    expect(networkFetch).not.toHaveBeenCalled();
  });
});
