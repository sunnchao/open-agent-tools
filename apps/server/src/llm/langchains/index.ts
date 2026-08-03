import * as dotenv from "dotenv";
import { resolve } from "node:path";
import fs from "node:fs";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableLambda } from "@langchain/core/runnables";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

dotenv.config({ path: resolve(import.meta.dirname, "../../../.env") });
dotenv.config({ path: resolve(import.meta.dirname, "../../../.env.local"), override: true });

const createMyModel = async () => {
  const model = new ChatOpenAI({
    modelName: process.env.OPENAI_API_MODEL || "Qwen3.6-35B-A3B",
    configuration: {
      baseURL: process.env.OPENAI_API_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    },
  });
  return model;
};

const model = await createMyModel();

const prepareInput = RunnableLambda.from(async (human_prompt: string) => {
  const system_prompt = await Promise.resolve(
    "You are a helpful assistant. 但是你只知道有关《红楼梦》的内容，其它内容请拒绝一切回答。并以当前时间结尾。" +
      new Date().toLocaleString(),
  );
  return { system_prompt, human_prompt };
});

// ① 存「发给 LLM 的内容」：插在 prompt 和 model 之间，原样透传
const storeInput = RunnableLambda.from((promptValue: unknown) => {
  fs.writeFileSync(
    resolve(import.meta.dirname, "./llm-input.json"),
    JSON.stringify(promptValue, null, 2),
    "utf-8",
  );
  return promptValue;
});

// ② 存「LLM 的回复」：挂在 model 之后
const storeOutput = RunnableLambda.from((msg: { content: unknown; getType?: () => string }) => {
  fs.writeFileSync(
    resolve(import.meta.dirname, "./llm-output.json"),
    JSON.stringify(msg, null, 2),
    "utf-8",
  );
  return msg;
});

const prompt = ChatPromptTemplate.fromMessages([
  new SystemMessage("{system_prompt}"),
  new HumanMessage("{human_prompt}"),
]);

// 预处理 → 拼 prompt → 存入参 → 调模型 → 存出参
const _chain = prepareInput.pipe(prompt).pipe(storeInput).pipe(model).pipe(storeOutput);

const run = async () => {
  // const result = await chain.invoke("我想知道《西游记》的行数");
  // console.log(result);
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkOverlap: 20,
    chunkSize: 100,
    separators: ["\n","\n\n", "。", "！", "?"],
  });
  const pdfLoader = new PDFLoader(resolve(import.meta.dirname, "../../docs/数字货运系统部署说明-V1.2.pdf"));
  const pdfContent = await pdfLoader.load();
  // 归一化 source 为相对路径，避免把机器相关的绝对路径写入生成产物
  for (const doc of pdfContent) {
    if (doc.metadata?.source) {
      doc.metadata.source = "../../docs/数字货运系统部署说明-V1.2.pdf";
    }
  }
  fs.writeFileSync(resolve(import.meta.dirname, "./pdf-content.json"), JSON.stringify(pdfContent, null, 2), "utf-8");
  // 保存分块内容
  const pdfContentSplit = await textSplitter.splitDocuments(pdfContent);
  fs.writeFileSync(resolve(import.meta.dirname, "./pdf-content-split.json"), JSON.stringify(pdfContentSplit, null, 2), "utf-8");
};

run();
