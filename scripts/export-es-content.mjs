#!/usr/bin/env node
/**
 * 导出 Elasticsearch 里的全部知识库内容（文档目录 + 分块原文）为可读文件。
 *
 * 用途：不装任何工具就能通读 ES 里到底存了什么；也方便对比 PG 与 ES 的内容是否一致。
 *
 * 用法：
 *   node scripts/export-es-content.mjs                       # 导出到 exports/es-content-<时间戳>/
 *   node scripts/export-es-content.mjs --out /tmp/es-dump     # 指定目录
 *   node scripts/export-es-content.mjs --source lol-heroes-all.md   # 只看某个文档
 *   node scripts/export-es-content.mjs --limit 5             # 每个文档最多导出 5 个分块（抽查用）
 *
 * 环境变量（缺省读 apps/rag-server/.env）：
 *   RAG_ES_NODE、RAG_ES_INDEX_PREFIX（默认 rag）
 *
 * 产物：
 *   documents.jsonl  每行一个文档目录（title/tags/chunk_count/version...）
 *   chunks.jsonl     每行一个分块（含 id/source/chunk_index/content）
 *   knowledge-base.md 人读版：按文档分节，逐段列出内容
 *
 * 说明：ES 里的 `embedding` 字段是空的（向量只在 PostgreSQL），本脚本不导出它。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadRagEnv } from "./lib/rag-env.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};

const envFile = loadRagEnv();
const node = (process.env.RAG_ES_NODE ?? "http://localhost:9200").replace(/\/+$/, "");
const prefix = process.env.RAG_ES_INDEX_PREFIX?.trim() || "rag";
const chunksIndex = `${prefix}-chunks`;
const documentsIndex = `${prefix}-documents`;
const sourceFilter = flag("source");
const limit = Number(flag("limit")) || 0;
const outDir = resolve(
  flag("out") ??
    `exports/es-content-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}`,
);

/** 走 REST API（不引 ES 客户端，脚本零依赖）。 */
async function call(path, body) {
  const response = await fetch(`${node}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`${path} -> HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

/** 用 search_after 翻页，避开 max_result_window(10000) 限制。 */
async function fetchAll(index, sourceFields, query, pageSize = 500) {
  const rows = [];
  let searchAfter;
  for (;;) {
    const body = {
      size: pageSize,
      query,
      sort: [{ source: "asc" }, { chunk_index: "asc" }, { id: "asc" }],
      _source: sourceFields,
      ...(searchAfter ? { search_after: searchAfter } : {}),
    };
    const result = await call(`/${index}/_search`, body).catch(async (error) => {
      // documents 索引没有 chunk_index/id 字段，退化为按 source 排序。
      if (String(error.message).includes("No mapping found for")) {
        return call(`/${index}/_search`, {
          size: pageSize,
          query,
          sort: [{ source: "asc" }],
          _source: sourceFields,
          ...(searchAfter ? { search_after: searchAfter } : {}),
        });
      }
      throw error;
    });
    const hits = result.hits?.hits ?? [];
    for (const hit of hits) rows.push(hit._source);
    if (hits.length < pageSize) break;
    searchAfter = hits[hits.length - 1].sort;
    if (!searchAfter) break;
  }
  return rows;
}

const filter = sourceFilter
  ? { bool: { should: [{ term: { source: sourceFilter } }, { term: { _id: sourceFilter } }] } }
  : { match_all: {} };

console.log(
  `[export] env=${envFile ?? "(process.env)"} es=${node} indices=${chunksIndex},${documentsIndex}`,
);
const documents = await fetchAll(
  documentsIndex,
  [
    "source",
    "title",
    "tags",
    "allowed_groups",
    "mime_type",
    "byte_size",
    "content_hash",
    "chunk_count",
    "version",
    "chunk_strategy",
    "chunk_size",
    "chunk_overlap",
    "ocr_applied",
    "ocr_status",
    "created_at",
    "updated_at",
  ],
  filter,
);

const chunks = await fetchAll(chunksIndex, ["id", "source", "chunk_index", "content"], filter);

mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, "documents.jsonl"),
  documents.map((row) => JSON.stringify(row)).join("\n") + "\n",
  "utf8",
);
writeFileSync(
  resolve(outDir, "chunks.jsonl"),
  chunks.map((row) => JSON.stringify(row)).join("\n") + "\n",
  "utf8",
);

const bySource = new Map();
for (const chunk of chunks) {
  if (!bySource.has(chunk.source)) bySource.set(chunk.source, []);
  bySource.get(chunk.source).push(chunk);
}
for (const list of bySource.values()) {
  list.sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0));
}

const lines = [
  "# Elasticsearch 知识库内容导出",
  "",
  `- 节点：\`${node}\``,
  `- 索引：\`${chunksIndex}\`（${chunks.length} 个分块）、\`${documentsIndex}\`（${documents.length} 个文档）`,
  `- 导出时间：${new Date().toISOString()}`,
  sourceFilter ? `- 过滤来源：\`${sourceFilter}\`` : "",
  limit > 0 ? `- 每个文档最多 ${limit} 个分块` : "",
  "",
];
for (const document of documents) {
  const items = bySource.get(document.source) ?? [];
  lines.push(`## ${document.title || document.source}`, "");
  lines.push(
    `- 来源：\`${document.source}\``,
    `- MIME：${document.mime_type} · 大小：${document.byte_size} 字节`,
    `- 分块：${items.length}（目录记录 ${document.chunk_count}）· 版本 v${document.version}`,
    `- 切分策略：${document.chunk_strategy}（size=${document.chunk_size}, overlap=${document.chunk_overlap}）`,
    `- OCR：${document.ocr_status} · 更新时间：${document.updated_at}`,
    "",
  );
  const shown = limit > 0 ? items.slice(0, limit) : items;
  for (const chunk of shown) {
    lines.push(`### #${(chunk.chunk_index ?? 0) + 1}`, "", "```text", chunk.content, "```", "");
  }
  if (shown.length < items.length) {
    lines.push(
      `> 其余 ${items.length - shown.length} 个分块已省略（用 --limit 0 或去掉 --limit 导出全部）`,
      "",
    );
  }
}

writeFileSync(resolve(outDir, "knowledge-base.md"), lines.join("\n"), "utf8");

console.log(`[export] documents=${documents.length} chunks=${chunks.length}`);
console.log(`[export] 输出目录：${outDir}`);
console.log(`[export]   - documents.jsonl / chunks.jsonl / knowledge-base.md`);
