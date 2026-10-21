/**
 * 移动端文件基础设施：文档选择 / 缓存落盘 / 系统分享 / SHA-256。
 * 纯函数（base64/sha256）无原生依赖，可单测。
 */

import {
  getDocumentAsync,
  getFileInfo,
  getFileSystemCacheDirectory,
  isSharingAvailable,
  readFileAsBase64,
  shareFile,
  writeFileFromBase64,
} from "./nativeFiles";

export interface PickedFile {
  name: string;
  size: number;
  mimeType?: string;
  uri?: string;
  data: Uint8Array;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += (B64[(n >> 18) & 63] ?? "") + (B64[(n >> 12) & 63] ?? "");
    out += i + 1 < bytes.length ? (B64[(n >> 6) & 63] ?? "") : "=";
    out += i + 2 < bytes.length ? (B64[n & 63] ?? "") : "=";
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const len = clean.length;
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array(((len * 3) >> 2) - pad);
  const val = (ch: string): number => (ch === "=" ? 0 : B64.indexOf(ch));
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const n =
      (val(clean[i]!) << 18) |
      (val(clean[i + 1]!) << 12) |
      (val(clean[i + 2]!) << 6) |
      val(clean[i + 3]!);
    if (p < out.length) out[p++] = (n >> 16) & 255;
    if (p < out.length) out[p++] = (n >> 8) & 255;
    if (p < out.length) out[p++] = n & 255;
  }
  return out;
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** 纯 TS SHA-256（FIPS 180-4），Hermes/单测均可跑，与 Web crypto.subtle 同结果。 */
export function sha256HexBytes(data: Uint8Array): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a;
  let h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;
  const bitLen = data.length * 8;
  const paddedLen = (((data.length + 8) >> 6) + 1) * 64;
  const msg = new Uint8Array(paddedLen);
  msg.set(data);
  msg[data.length] = 0x80;
  const dv = new DataView(msg.buffer);
  // 64 位长度：高 32 位通常为 0（>512MB 文件走原生 crypto，此处仅兜底）
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 2 ** 32));
  dv.setUint32(paddedLen - 4, bitLen >>> 0);
  const w = new Array<number>(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((x) => (x >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

export function sha256HexText(text: string): string {
  return sha256HexBytes(new TextEncoder().encode(text));
}

/** 与 Web 端一致的 `sha256:<hex>` 摘要格式（upload-url 接口要求）。 */
export function sha256DigestOf(bytes: Uint8Array): string {
  return `sha256:${sha256HexBytes(bytes)}`;
}

async function readUriAsBytes(uri: string): Promise<{ bytes: Uint8Array; size: number }> {
  const base64 = await readFileAsBase64(uri);
  const bytes = base64ToBytes(base64);
  let size = bytes.length;
  try {
    const info = await getFileInfo(uri);
    const infoSize = info.size;
    if (info.exists && typeof infoSize === "number" && infoSize > 0) size = infoSize;
  } catch {
    /* ignore */
  }
  return { bytes, size };
}

/**
 * 系统文档选择器（多选可选）。返回内存字节，调用方直接喂给
 * RAG `uploadDocuments` 或 MCP `uploadArtifact`。
 */
export async function pickDocuments(options?: {
  multiple?: boolean;
  mimeTypes?: string[];
}): Promise<PickedFile[]> {
  const res = await getDocumentAsync({
    type: options?.mimeTypes ?? "*/*",
    multiple: options?.multiple ?? false,
    copyToCacheDirectory: true,
  });
  if (res.canceled) return [];
  const out: PickedFile[] = [];
  for (const a of res.assets) {
    const { bytes, size } = await readUriAsBytes(a.uri);
    out.push({ name: a.name, size: a.size ?? size, mimeType: a.mimeType, uri: a.uri, data: bytes });
  }
  return out;
}

function webDownload(blob: Blob, filename: string): string {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

/** Web downloads directly; native platforms persist to cache and open the share sheet. */
export async function saveBlobAndShare(blob: Blob, filename: string): Promise<string> {
  const cacheDirectory = getFileSystemCacheDirectory();
  if (!cacheDirectory) {
    if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
      throw new Error("当前环境不支持文件导出");
    }
    return webDownload(blob, filename);
  }
  const buf = new Uint8Array(await blob.arrayBuffer());
  const uri = `${cacheDirectory}${filename}`;
  await writeFileFromBase64(uri, bytesToBase64(buf));
  if (await isSharingAvailable()) {
    await shareFile(uri);
  }
  return uri;
}

/** 审计/用量导出的 App 侧落盘入口（对应 Web 的 triggerBlobDownload）。 */
export async function shareExport(download: { blob: Blob; filename: string }): Promise<string> {
  return saveBlobAndShare(download.blob, download.filename);
}
