import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  callTool: vi.fn(),
  clientClose: vi.fn(),
  connect: vi.fn(),
  Client: vi.fn(),
  Transport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: sdk.Client.mockImplementation(() => ({
    callTool: sdk.callTool,
    close: sdk.clientClose,
    connect: sdk.connect,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: sdk.Transport.mockImplementation(function () {
    return { kind: "transport" };
  }),
}));

import { callGatewayTool } from "./gateway.js";

describe("MCP Gateway client", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { location: { origin: "http://studio.local" } });
    sdk.callTool.mockReset();
    sdk.clientClose.mockReset().mockResolvedValue(undefined);
    sdk.connect.mockReset().mockResolvedValue(undefined);
    sdk.Client.mockClear();
    sdk.Transport.mockClear();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("connects to the service endpoint and executes the selected Tool with a Bearer key", async () => {
    const result = { content: [{ type: "text", text: "done" }] };
    sdk.callTool.mockResolvedValue(result);

    await expect(
      callGatewayTool({
        serviceSlug: "report tools",
        apiKey: "  mcp.secret  ",
        toolName: "get_report",
        arguments: { year: 2026 },
      }),
    ).resolves.toEqual(result);

    expect(sdk.Transport).toHaveBeenCalledWith(
      new URL("http://studio.local/mcp/services/report%20tools"),
      { requestInit: { headers: { authorization: "Bearer mcp.secret" } } },
    );
    expect(sdk.connect).toHaveBeenCalledWith({ kind: "transport" });
    expect(sdk.callTool).toHaveBeenCalledWith({
      name: "get_report",
      arguments: { year: 2026 },
    });
    expect(sdk.clientClose).toHaveBeenCalledOnce();
  });

  it("closes the SDK client when the Gateway call fails", async () => {
    sdk.callTool.mockRejectedValue(new Error("Gateway unavailable"));

    await expect(
      callGatewayTool({
        serviceSlug: "reports",
        apiKey: "mcp.secret",
        toolName: "get_report",
        arguments: {},
      }),
    ).rejects.toThrow("Gateway unavailable");
    expect(sdk.clientClose).toHaveBeenCalledOnce();
  });
});
