import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main() {
  const client = new Client({
    name: "MCP Test Client",
    version: "1.0.0",
  });
  const url = new URL("https://mcp.api-inference.modelscope.net/c309f54dd2b642/mcp");
  const transport = new StreamableHTTPClientTransport(url);
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
