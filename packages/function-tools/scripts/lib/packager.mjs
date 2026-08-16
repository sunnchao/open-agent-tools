/**
 * 工具包打包引擎（共享模块）：校验 → 暂存（剔除缓存/非必要文件）→ 生成 ZIP → 验证产物。
 *
 * 供两类入口复用：
 *  - packages/function-tools/scripts/build-package.mjs   （交互式选择）
 *  - packages/function-tools/scripts/build-package.mjs   （function-tools 交互式/单工具打包）
 *
 * 校验规则对齐 Worker：apps/mcp-worker/src/infrastructure/node-package.ts
 * ZIP 安全规则对齐 Worker：apps/mcp-worker/src/infrastructure/archive.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

/** 上传包必需的顶层文件 */
export const REQUIRED_FILES = ["mcp.json", "package.json", "package-lock.json"];
/** Worker 允许的 npm lockfile 版本 */
export const LOCKFILE_VERSIONS = new Set([2, 3]);

/** 顶层目录/文件：非运行必需（缓存/本地/开发脚本），一律不进入代码包 */
export const EXCLUDED_TOP_LEVEL = new Set([
  "node_modules",
  "scripts",
  "test",
  "migrations",
  "dist",
  ".build",
  "Dockerfile",
  "README.md",
  ".git",
]);
/** 任意层级的缓存/系统文件（按文件名） */
export const EXCLUDED_BASENAMES = new Set([".DS_Store", ".gitignore", ".npmrc", ".eslintcache"]);
/** 任意层级的缓存/临时文件（按后缀） */
export const EXCLUDED_SUFFIXES = [
  ".zip",
  ".tgz",
  ".tar",
  ".gz",
  ".tsbuildinfo",
  ".log",
  ".tmp",
  ".bak",
  ".swp",
];

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${basename(file)} 不是合法 JSON：${error.message}`);
  }
}

export function isExcluded(relPath) {
  const parts = relPath.split("/");
  const top = parts[0];
  const base = parts[parts.length - 1];
  if (EXCLUDED_TOP_LEVEL.has(top)) return true;
  if (EXCLUDED_BASENAMES.has(base)) return true;
  if (EXCLUDED_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  return false;
}

/**
 * 本地校验工具包结构，规则对齐 Worker 的 readNodeToolPackage。
 * @param {string} toolDir
 * @returns {{ name: string, tools: string[], entry: string }}
 */
export function validateToolPackage(toolDir) {
  const errors = [];
  for (const name of REQUIRED_FILES) {
    if (!existsSync(join(toolDir, name))) errors.push(`缺少必需文件 ${name}`);
  }
  if (errors.length > 0) throw new Error(errors.join("；"));

  const pkg = readJson(join(toolDir, "package.json"));
  const lock = readJson(join(toolDir, "package-lock.json"));
  const manifest = readJson(join(toolDir, "mcp.json"));

  if (pkg.type !== "module") errors.push('package.json 必须声明 "type": "module"');
  if (!LOCKFILE_VERSIONS.has(lock.lockfileVersion)) {
    errors.push(`package-lock.json lockfileVersion 必须为 2 或 3（当前 ${lock.lockfileVersion}）`);
  }
  const lockRoot = lock.packages?.[""];
  if (lockRoot && lockRoot.name !== pkg.name) {
    errors.push("package-lock.json 根 name 与 package.json 不一致");
  }
  if (lockRoot && lockRoot.version !== pkg.version) {
    errors.push("package-lock.json 根 version 与 package.json 不一致");
  }
  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
    errors.push("mcp.json 必须声明至少一个 Tool");
  }
  if (typeof manifest.entry !== "string" || manifest.entry.length === 0) {
    errors.push("mcp.json 必须声明 entry");
  } else if (!existsSync(join(toolDir, ...manifest.entry.split("/")))) {
    errors.push(`mcp.json 声明的 entry 不存在：${manifest.entry}`);
  }

  if (errors.length > 0) throw new Error(errors.join("；"));
  return { name: pkg.name ?? basename(toolDir), tools: manifest.tools.map((tool) => tool.name) };
}

/**
 * 列出根目录下所有工具（含 mcp.json 的子目录）；校验失败的工具也会列出（带 invalid 说明）。
 * @param {string} root
 * @returns {Promise<Array<{ name: string, tools: string[], dir: string, invalid?: string }>>}
 */
export async function listToolDirs(root) {
  const candidates = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) => !["dist", "scripts", "node_modules", ".build"].includes(name));

  const tools = [];
  for (const name of candidates) {
    const dir = join(root, name);
    if (!existsSync(join(dir, "mcp.json"))) continue;
    try {
      tools.push({ ...validateToolPackage(dir), dir });
    } catch (error) {
      tools.push({ name, tools: [], dir, invalid: error.message });
    }
  }
  return tools;
}

/** 只复制允许进入代码包的文件到暂存目录（"剔除缓存文件"的实现） */
async function copyAllowedFiles(toolDir, stageDir) {
  const copied = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(toolDir, abs);
      if (isExcluded(rel)) continue;
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const dest = join(stageDir, rel);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(abs, dest);
        copied.push(rel);
      }
    }
  }
  await walk(toolDir);
  return copied;
}

function verifyZipListing(entries) {
  for (const required of REQUIRED_FILES) {
    if (!entries.includes(required)) throw new Error(`ZIP 缺少必需条目 ${required}`);
  }
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.includes("\\") || entry.split("/").includes("..")) {
      throw new Error(`ZIP 含不安全路径：${entry}`);
    }
    if (entry.startsWith("node_modules/") || entry.startsWith("test/") || entry.includes(".DS_Store")) {
      throw new Error(`ZIP 混入非必要文件：${entry}`);
    }
  }
}

/**
 * 打包单个工具：校验 → 暂存（剔除缓存）→ zip → 校验产物。
 * @param {string} toolDir
 * @param {{ distDir: string, zipName?: string }} options
 * @returns {Promise<{ name: string, tools: string[], zipPath: string, zipName: string, size: number, files: number }>}
 */
export async function buildToolPackage(toolDir, { distDir, zipName }) {
  const info = validateToolPackage(toolDir);
  const outName = zipName ?? `${info.name}.zip`;
  const zipPath = join(distDir, outName);
  const stageDir = join(resolve(distDir, ".."), ".build", info.name);

  await mkdir(distDir, { recursive: true });
  await rm(stageDir, { recursive: true, force: true });
  await rm(zipPath, { force: true }); // 先删旧包，避免 zip -r 残留过期条目
  await mkdir(stageDir, { recursive: true });

  const copied = await copyAllowedFiles(toolDir, stageDir);
  if (copied.length === 0) throw new Error("没有可打包的文件（全部被排除？）");

  // 生成 ZIP：相对路径条目（形如 mcp.json / src/index.js），兼容 Worker archive 校验
  execFileSync("zip", ["-r", "-q", zipPath, ".", "-x", "__MACOSX/*"], {
    cwd: stageDir,
    stdio: "ignore",
  });
  await rm(stageDir, { recursive: true, force: true });

  const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  verifyZipListing(listing);

  const { size } = await stat(zipPath);
  return { ...info, zipPath, zipName: outName, size, files: listing.length };
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
