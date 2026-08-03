import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const client = new Client({
    name: "MCP Test Client",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({ command: "npx", args: ["-y", "bing-cn-mcp"] });
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
