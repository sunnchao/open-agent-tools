import { Client } from "@modelcontextprotocol/sdk/client";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const apiKey = process.env.MODELSCOPE_API_KEY;
  if (!apiKey) {
    throw new Error("MODELSCOPE_API_KEY is required");
  }

  const client = new Client({
    name: "MCP Test Client",
    version: "1.0.0",
  });
  const url = new URL("https://mcp.api-inference.modelscope.net/de22714ee06246/sse");
  const transport = new SSEClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  });
  await client?.connect(transport);
  //   const toolResult = await client?.listTools();
  const toolResult = await client.callTool({
    name: "bing_search",
    arguments: {
      query: "俄乌战争信息",
    },
  });

  console.log(toolResult);
}

main();
