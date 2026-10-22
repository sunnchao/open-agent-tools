/**
 * 极简 `.env` 读取，供 `scripts/` 下的运维脚本复用。
 *
 * 不引入 dotenv 依赖（仓库根目录没有该模块），只支持本项目 .env 的实际用法：
 * `KEY=VALUE` 单行、可带引号、`#` 注释、行首空格（`apps/rag-server/.env` 里就有）。
 *
 * 语义与 dotenv 一致：**不覆盖已存在的 process.env**，所以命令行内联的环境变量优先。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 按优先级查找 .env：工作目录下的 apps/rag-server/.env，其次工作目录下的 .env。 */
export function findEnvFile(startDir = process.cwd()) {
  return [
    resolve(startDir, "apps/rag-server/.env"),
    resolve(startDir, "apps/rag-server/.env.local"),
    resolve(startDir, ".env"),
  ].find((candidate) => existsSync(candidate));
}

/** 把 .env 灌进 process.env（不覆盖已有值）。返回实际读取的文件路径或 undefined。 */
export function loadRagEnv(startDir = process.cwd()) {
  const file = findEnvFile(startDir);
  if (!file) return undefined;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
  return file;
}
