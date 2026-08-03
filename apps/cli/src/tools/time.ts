import { tool } from "@langchain/core/tools";
import { z } from "zod";

/** 获取当前时间（ISO 8601）。无害工具，无需权限确认。 */
export const getCurrentTime = tool(
  async () => {
    return JSON.stringify({ time: new Date().toISOString() });
  },
  {
    name: "getCurrentTime",
    description: "获取当前时间，ISO 8601 格式。",
    schema: z.object({}),
  },
);
