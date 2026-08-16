#!/usr/bin/env node
/**
 * build-package（交互式）：列出 function-tools 下的自定义工具 → 选择 → 打包。
 *
 * 用法：
 *   npm run build-package                    # 交互式：显示工具列表，选择后打包
 *   npm run build-package -- --tool=<name>   # 非交互：直接打包指定工具（CI 用）
 *   npm run build-package -- --clean         # 先清空 dist/ 再打包
 *
 * 产物：packages/function-tools/dist/<tool-name>.zip（供 MCP 控制面 upload-package 上传）
 * 打包引擎：./lib/packager.mjs（与公共工具共享，剔除缓存/测试/本地文件）
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm } from "node:fs/promises";
import { buildToolPackage, formatSize, listToolDirs } from "./lib/packager.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = join(ROOT, "dist");

function fail(message) {
  console.error(`  ✗ ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const tool = argv.find((arg) => arg.startsWith("--tool="))?.slice("--tool=".length);
  const clean = argv.includes("--clean");
  return { tool, clean };
}

/** 解析选择输入：支持 "1,3"、"1 3"、"1-3" 混合 */
function parseSelection(answer, tools) {
  const tokens = answer.split(/[,，\s]+/).filter(Boolean);
  const indexes = new Set();
  for (const token of tokens) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const [start, end] = [Number(range[1]), Number(range[2])];
      if (start < 1 || end > tools.length || start > end) {
        return { error: `无效区间 ${token}（有效范围 1-${tools.length}）` };
      }
      for (let i = start; i <= end; i += 1) indexes.add(i);
    } else if (/^\d+$/.test(token)) {
      const index = Number(token);
      if (index < 1 || index > tools.length) {
        return { error: `序号 ${index} 超出范围（有效范围 1-${tools.length}）` };
      }
      indexes.add(index);
    } else {
      return { error: `无法识别 "${token}"` };
    }
  }
  if (indexes.size === 0) return { error: "未选择任何工具" };
  return { names: [...indexes].sort((a, b) => a - b).map((i) => tools[i - 1].name) };
}

/** 提问：与 readline 的 close 事件赛跑，EOF/中断时返回 null（避免挂起或静默退出） */
function ask(rl, hint) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      rl.off("close", onClose);
      resolvePromise(value);
    };
    const onClose = () => finish(null);
    rl.on("close", onClose);
    rl.question(hint).then(finish, () => finish(null));
  });
}

/** 交互选择：返回选中的工具名数组；取消返回 null */
async function chooseTools(tools) {
  const rl = createInterface({ input: stdin, output: stdout });
  const interactive = stdin.isTTY === true;
  try {
    while (true) {
      const hint = interactive
        ? "请选择要打包的工具（序号可逗号/空格分隔，支持区间如 1-3；回车=全部；q=退出）："
        : "非交互终端，请输入序号后回车（多个用逗号分隔；空输入=取消）：";
      const raw = await ask(rl, hint);
      if (raw === null) {
        console.log("[build-package] 输入中断，已取消");
        return null;
      }
      const answer = raw.trim().toLowerCase();
      if (answer === "q" || answer === "quit" || answer === "exit") {
        console.log("[build-package] 已取消");
        return null;
      }
      if (answer === "") {
        if (!interactive) {
          console.log("[build-package] 无输入，已取消（CI 请用 --tool=<name> 指定）");
          return null;
        }
        return tools.map((tool) => tool.name); // 交互终端回车 = 全部
      }
      if (answer === "0" || answer === "all") return tools.map((tool) => tool.name);
      const selected = parseSelection(answer, tools);
      if (selected.error) {
        console.log(`  ⚠ ${selected.error}，请重新输入`);
        continue;
      }
      return selected.names;
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const { tool, clean } = parseArgs(process.argv.slice(2));

  if (clean) {
    await rm(DIST_DIR, { recursive: true, force: true });
    console.log("[build-package] 已清空 dist/");
  }
  await mkdir(DIST_DIR, { recursive: true });

  const tools = await listToolDirs(ROOT);
  if (tools.length === 0) {
    console.log("[build-package] function-tools 下暂无工具（需含 mcp.json 的子目录）");
    return;
  }

  let targets;
  if (tool !== undefined) {
    const match = tools.find((candidate) => candidate.name === tool);
    if (!match) {
      fail(`未找到工具 "${tool}"，可用：${tools.map((candidate) => candidate.name).join(", ") || "（无）"}`);
      return;
    }
    targets = [tool];
  } else {
    console.log("[build-package] function-tools 下的工具：");
    for (const [index, candidate] of tools.entries()) {
      const suffix = candidate.invalid ? `  ⚠ 校验失败：${candidate.invalid}` : `  tools=[${candidate.tools.join(", ")}]`;
      console.log(`  ${index + 1}) ${candidate.name}${suffix}`);
    }
    console.log("  0) 全部打包");
    const selected = await chooseTools(tools);
    if (selected === null) return;
    targets = selected;
  }

  console.log(`[build-package] 开始打包：${targets.join(", ")}`);
  let succeeded = 0;
  for (const name of targets) {
    try {
      const result = await buildToolPackage(join(ROOT, name), { distDir: DIST_DIR });
      succeeded += 1;
      console.log(
        `  ✓ ${result.name}  tools=[${result.tools.join(", ")}]  文件 ${result.files} 个  ${formatSize(result.size)}  dist/${result.zipName}`,
      );
    } catch (error) {
      fail(`${name}：${error.message}`);
    }
  }
  const allOk = succeeded === targets.length;
  console.log(allOk ? "[build-package] 打包完成" : "[build-package] 存在失败项，请检查上方错误");
}

main().catch((error) => {
  fail(error.message);
});
