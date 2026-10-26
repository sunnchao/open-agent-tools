/**
 * tsc 只输出 JS，不拷贝运行时静态资源。
 * dist/ 下需要与 src/ 同构的文件在此显式列出。
 */
import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ASSETS = [
  ["src/features/query/text2sql/oneapi-demo.html", "dist/features/query/text2sql/oneapi-demo.html"],
];

const root = resolve(import.meta.dirname, "..");

for (const [from, to] of ASSETS) {
  const target = resolve(root, to);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(resolve(root, from), target);
}

console.log(`copied ${ASSETS.length} static asset(s) to dist`);
