import { Router, type Request, type Response } from "express";
import { clearMcpGatewayConfig, getMcpGatewayConfig, saveMcpGatewayConfig } from "./store.js";

export const mcpGatewayRouter: ReturnType<typeof Router> = Router();

mcpGatewayRouter.get("/api/admin/mcp-gateway", (_req: Request, res: Response) => {
  try {
    res.json({ config: getMcpGatewayConfig() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

mcpGatewayRouter.put("/api/admin/mcp-gateway", (req: Request, res: Response) => {
  const body = req.body as { gatewayUrl?: unknown; apiKey?: unknown } | undefined;
  try {
    const config = saveMcpGatewayConfig({
      gatewayUrl: typeof body?.gatewayUrl === "string" ? body.gatewayUrl : "",
      ...(typeof body?.apiKey === "string" ? { apiKey: body.apiKey } : {}),
    });
    res.json({ config });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

mcpGatewayRouter.delete("/api/admin/mcp-gateway", (_req: Request, res: Response) => {
  try {
    res.json({ config: clearMcpGatewayConfig() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
