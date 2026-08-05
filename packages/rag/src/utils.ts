import { createHash } from "node:crypto";

/** sha1 十六进制摘要，用于生成分块稳定 ID。 */
export function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

/** Float32Array 序列化为小端序字节（存入 SQLite BLOB）。 */
export function serializeF32(v: Float32Array): Uint8Array {
  const buf = new ArrayBuffer(v.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < v.length; i++) {
    view.setFloat32(i * 4, v[i] ?? 0, true);
  }
  return new Uint8Array(buf);
}

/** 从 SQLite BLOB 反序列化 Float32Array（复制 buffer，避免字节偏移问题）。 */
export function deserializeF32(bytes: Uint8Array): Float32Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

/** 余弦相似度，返回 [-1, 1]。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** CJK 字符区间（常用汉字 + 扩展 A + CJK 兼容区）。 */
const CJK_RE = /([\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff])/g;

/** 口语停用词（单字与常见词），避免 AND 查询被"怎么办/如何"这类词拖垮。 */
const STOP_WORDS = new Set([
  "的", "了", "吗", "呢", "啊", "吧", "呀", "哦", "嘛", "哈", "嗯",
  "这", "那", "我", "你", "他", "她", "它", "们",
  "是", "在", "和", "与", "或", "也", "都", "要", "就", "很", "有",
  "什么", "怎么", "如何", "为什么", "请问", "一下", "一个", "可以", "能", "请",
]);

/**
 * 在连续 CJK 字符之间插入空格，使 FTS5 unicode61 分词器按单字建立 token。
 * 中文 BM25 单字检索的经典做法：召回稳，精度靠 RRF 的向量侧与 Top-K 兜底。
 */
export function addCjkSpacing(text: string): string {
  return text.replace(CJK_RE, " $1 ").replace(/\s+/g, " ").trim();
}

/** 规范化查询串：CJK 切分 + 去特殊字符 + 拆词 + 滤停用词。 */
function normalizeTokens(query: string): string[] {
  return addCjkSpacing(query)
    .replace(/["(){}*\\^~:]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

/**
 * 将用户查询转义为 FTS5 查询串（AND 语义）：词间默认 AND，精确优先。
 */
export function escapeFtsQuery(query: string): string {
  const tokens = normalizeTokens(query).map((t) => `"${t}"`);
  return tokens.join(" ");
}

/**
 * OR 语义版本：AND 无结果时降级使用，避免口语化查询全军覆没。
 * BM25 会给命中词更多的文档更高分，排序仍可靠。
 */
export function escapeFtsQueryOr(query: string): string {
  const tokens = normalizeTokens(query).map((t) => `"${t}"`);
  return tokens.join(" OR ");
}
