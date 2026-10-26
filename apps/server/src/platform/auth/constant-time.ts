/**
 * 定长比较：凭据与摘要一律走这里，避免各处重复实现。
 *
 * 字符串版本先按 UTF-8 编码再比；长度不同直接判否（长度本身不是秘密）。
 */
import { timingSafeEqual } from "node:crypto";

export function constantTimeEqual(a: string, b: string): boolean {
  return constantTimeEqualBytes(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function constantTimeEqualBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
