// 构建时把 src/resources 下的资源文件（文本/图片等）拷贝到 dist/resources，
// 使运行时从 dist 读取资源与从 src 读取资源保持一致的目录布局。
import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await cp(join(root, "src", "resources"), join(root, "dist", "resources"), {
  recursive: true,
});
console.error("copied src/resources -> dist/resources");
