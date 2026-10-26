/** 回复文本分片：优先在换行/句末断行，避免切碎长段落。 */
export function chunkText(text: string, maxLength = 1500): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxLength) return [clean];

  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf("\n", maxLength);
    if (cut <= 0) cut = rest.lastIndexOf("。", maxLength);
    if (cut <= 0) cut = rest.lastIndexOf(".", maxLength);
    if (cut <= 0) cut = maxLength;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter((chunk) => chunk.length > 0);
}
