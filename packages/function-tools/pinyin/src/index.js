import { convertChineseToPinyin } from "./convert.js";

export const handlers = {
  async chineseToPinyin(args) {
    try {
      return convertChineseToPinyin(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pinyin conversion failed.";
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  },
};
