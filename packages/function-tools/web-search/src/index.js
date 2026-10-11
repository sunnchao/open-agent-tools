import { searchWeb } from "./search.js";

export const handlers = {
  async webSearch(args) {
    try {
      return await searchWeb(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Web search failed.";
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  },
};
