import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchWeb } from "./search.js";

const server = new McpServer({ name: "web-search", version: "1.0.0" });

server.tool(
  "web_search",
  "Search the public web through the configured Tavily proxy and return the answer plus source results.",
  {
    query: z.string().min(1).max(400).describe("The search query."),
    topic: z
      .enum(["general", "news", "finance"])
      .optional()
      .describe("Search topic. Defaults to general."),
    search_depth: z
      .enum(["basic", "advanced"])
      .optional()
      .describe("Search depth. Defaults to basic."),
    include_answer: z
      .boolean()
      .optional()
      .describe("Whether to include a generated answer. Defaults to true."),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Maximum number of source results, from 1 to 10. Defaults to 5."),
  },
  async (args) => searchWeb(args),
);

await server.connect(new StdioServerTransport());
