import { KnowledgeGraph, RuleGraphExtractor } from "./dist/index.js";
const g = new KnowledgeGraph({ dbPath: "/tmp/dbg-extract.db", extractor: new RuleGraphExtractor() });
const chunk = { id: "smoke-doc.txt:0", source: "smoke-doc.txt", chunkIndex: 0, content: "测试文档:OpenAI 发布 GPT-5 模型。Azure 提供云计算资源。Anthropic 是竞争对手。" };
const r = await g.ingest([chunk]);
console.log("ingest:", JSON.stringify(r));
console.log("stats:", JSON.stringify(g.getStats()));
console.log("retrieve:", JSON.stringify(g.retrieve("OpenAI").subgraph?.formatted()));
g.close();
console.log("OK");
