import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { resolve, relative, basename, extname, sep } from "node:path";

/**
 * 项目上下文生成模块（对应 Claude Code 的 /init）。
 *
 * generateProjectContext 会确定性地扫描当前仓库：目录树、技术栈、关键文件内容，
 * 再由 contextToMarkdown 渲染成一份放在仓库根目录的 AGENT.md。该文件会在每次会话
 * 开始时自动加载到系统提示词中，让 agent 无需每轮重新探索就能理解代码库。
 */

/** 上下文文件名（类似 Claude Code 的 CLAUDE.md，但与该 agent 工具绑定）。 */
export const CONTEXT_FILE_NAME = "AGENT.md";

/** 无论如何都要跳过的目录（与 .gitignore 之外的硬规则）。 */
const ALWAYS_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".workbuddy",
  ".turbo",
  ".cache",
  ".tmp",
  "target",
  "__pycache__",
]);

/** 关键文件正则（命中即视为值得写入上下文）。 */
const KEY_FILE_HINTS: RegExp[] = [
  /^readme(\.|$)/i,
  /^package\.json$/i,
  /^tsconfig.*\.json$/i,
  /\.config\.(ts|js|mjs|cjs)$/i,
  /^\.env\.example$/i,
  /^dockerfile$/i,
  /^makefile$/i,
  /^composer\.json$/i,
  /^go\.mod$/i,
  /^cargo\.toml$/i,
  /^pyproject\.toml$/i,
  /^gemfile$/i,
];

const MAX_KEY_FILE_CHARS = 6000;
const MAX_TREE_DEPTH = 4;
const MAX_FILES = 4000;

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript(React)",
  ".js": "JavaScript",
  ".jsx": "JavaScript(React)",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".rb": "Ruby",
  ".c": "C",
  ".cpp": "C++",
  ".cs": "C#",
  ".php": "PHP",
  ".json": "JSON",
  ".md": "Markdown",
  ".vue": "Vue",
  ".svelte": "Svelte",
};

export interface ProjectContext {
  root: string;
  name: string;
  description?: string;
  techStack: string[];
  fileCount: number;
  languageBreakdown: { ext: string; count: number; lang: string }[];
  tree: string;
  keyFiles: { path: string; content: string }[];
  generatedAt: string;
}

interface GitIgnore {
  matches(rel: string): boolean;
}

/** 读取仓库根目录的 .gitignore，返回一个宽松的子集匹配器（支持 * 通配与目录模式）。 */
function loadGitignore(root: string): GitIgnore {
  const path = resolve(root, ".gitignore");
  const patterns: RegExp[] = [];
  if (existsSync(path)) {
    try {
      const text = readFileSync(path, "utf-8");
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const dirOnly = line.endsWith("/");
        const p = line.replace(/\/+$/, "");
        if (!p) continue;
        let re = "";
        for (const ch of p) {
          if (ch === "*") re += ".*";
          else re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        }
        const anchored = p.includes("/");
        if (!anchored) re = `(^|/)${re}`;
        else re = `^${re}`;
        if (dirOnly) re += "(/|$)";
        else re += "($|/)";
        try {
          patterns.push(new RegExp(re));
        } catch {
          /* 跳过非法 pattern */
        }
      }
    } catch {
      /* 忽略读取错误 */
    }
  }
  return {
    matches(rel: string): boolean {
      return patterns.some((re) => re.test(rel));
    },
  };
}

/** 扫描仓库，生成结构化项目上下文。 */
export function generateProjectContext(root: string): ProjectContext {
  const ignore = loadGitignore(root);
  const files: string[] = [];
  const extCount = new Map<string, number>();
  const treeLines: string[] = [basename(root) || root];

  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > MAX_TREE_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    type Item = { name: string; isDir: boolean; rel: string };
    const items: Item[] = [];
    for (const e of entries) {
      const rel = relative(root, resolve(dir, e.name));
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name) || ignore.matches(rel)) continue;
        items.push({ name: e.name, isDir: true, rel });
      } else {
        if (ignore.matches(rel)) continue;
        items.push({ name: e.name, isDir: false, rel });
        if (files.length < MAX_FILES) files.push(rel);
        const ext = extname(e.name).toLowerCase() || "(无扩展名)";
        extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
      }
    }
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    items.forEach((item, idx) => {
      const last = idx === items.length - 1;
      treeLines.push(`${prefix}${last ? "└── " : "├── "}${item.name}${item.isDir ? "/" : ""}`);
      if (item.isDir) {
        walk(resolve(dir, item.name), prefix + (last ? "    " : "│   "), depth + 1);
      }
    });
  };
  walk(root, "", 1);

  // ---- 技术栈推断 ----
  const techStack: string[] = [];
  let description: string | undefined;
  const pkgPath = resolve(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        description?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      description = pkg.description;
      const keys = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
      const has = (re: RegExp) => keys.some((k) => re.test(k));
      if (has(/^@langchain\//)) techStack.push("LangChain");
      if (keys.includes("react") || keys.includes("react-dom")) techStack.push("React");
      if (keys.includes("next")) techStack.push("Next.js");
      if (keys.includes("vue")) techStack.push("Vue");
      if (keys.includes("svelte")) techStack.push("Svelte");
      if (keys.includes("express")) techStack.push("Express");
      if (keys.includes("fastify")) techStack.push("Fastify");
      if (keys.includes("koa")) techStack.push("Koa");
      if (keys.includes("typescript")) techStack.push("TypeScript");
      if (keys.includes("tailwindcss")) techStack.push("Tailwind CSS");
      if (has(/^(vite|webpack|esbuild|rollup|tsup|turbopack)/)) techStack.push("Bundler");
      if (has(/^(jest|vitest|mocha|playwright|@playwright)/)) techStack.push("Test Runner");
      if (keys.includes("zod")) techStack.push("Zod");
      if (existsSync(resolve(root, "pnpm-lock.yaml"))) techStack.push("pnpm");
      if (existsSync(resolve(root, "yarn.lock"))) techStack.push("Yarn");
      if (existsSync(resolve(root, "package-lock.json"))) techStack.push("npm");
    } catch {
      /* 忽略非法 JSON */
    }
  }
  if (!techStack.includes("TypeScript") && extCount.has(".ts")) techStack.push("TypeScript");

  const languageBreakdown = [...extCount.entries()]
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, 8)
    .map(([ext, count]) => ({ ext, count: count ?? 0, lang: LANG_BY_EXT[ext] ?? ext }));

  // ---- 关键文件内容 ----
  const keyFiles: { path: string; content: string }[] = [];
  for (const f of files) {
    const base = basename(f);
    if (base === CONTEXT_FILE_NAME) continue;
    const atRoot = !f.includes(sep);
    const isHint = KEY_FILE_HINTS.some((re) => re.test(base));
    if (!isHint && !(atRoot && /\.(toml|yml|yaml|json|md|env)$/i.test(f))) continue;
    try {
      const full = resolve(root, f);
      const stat = statSync(full);
      if (stat.size > 200_000) {
        keyFiles.push({ path: f, content: `(文件过大已跳过：${stat.size} 字节)` });
        continue;
      }
      let content = readFileSync(full, "utf-8");
      if (content.length > MAX_KEY_FILE_CHARS) {
        content = `${content.slice(0, MAX_KEY_FILE_CHARS)}\n…(内容截断，原文共 ${content.length} 字符)`;
      }
      keyFiles.push({ path: f, content });
    } catch {
      /* 忽略读取错误 */
    }
    if (keyFiles.length >= 25) break;
  }

  return {
    root,
    name: basename(root) || root,
    description,
    techStack,
    fileCount: files.length,
    languageBreakdown,
    tree: treeLines.join("\n"),
    keyFiles,
    generatedAt: new Date().toISOString(),
  };
}

/** 把结构化上下文渲染成 markdown（即 AGENT.md 的内容）。 */
export function contextToMarkdown(c: ProjectContext): string {
  const lines: string[] = [];
  lines.push(`# 项目上下文 (${CONTEXT_FILE_NAME})`);
  lines.push("");
  lines.push(
    `> 本文件由 open-agent-tools 的 \`/init\` 命令自动生成。你可以直接编辑它，补充项目约定、常用命令、注意事项等。\n` +
      `> 它会在每次会话开始时自动加载到系统提示词中，让 agent 立刻理解本仓库。`,
  );
  lines.push("");
  lines.push(`- **项目名称**: ${c.name}`);
  if (c.description) lines.push(`- **描述**: ${c.description}`);
  lines.push(`- **技术栈**: ${c.techStack.join(", ") || "未识别"}`);
  lines.push(`- **文件总数**: ${c.fileCount}`);
  lines.push(
    `- **主要语言**: ${c.languageBreakdown.map((l) => `${l.lang}/${l.ext}: ${l.count}`).join(", ")}`,
  );
  lines.push("");
  lines.push(`## 目录结构`);
  lines.push("");
  lines.push("```");
  lines.push(c.tree);
  lines.push("```");
  lines.push("");
  lines.push(`## 关键文件`);
  lines.push("");
  if (c.keyFiles.length === 0) {
    lines.push(`_(未识别到关键文件)_`);
    lines.push("");
  }
  for (const kf of c.keyFiles) {
    lines.push(`### ${kf.path}`);
    lines.push("");
    lines.push("```");
    lines.push(kf.content);
    lines.push("```");
    lines.push("");
  }
  lines.push(`---`);
  lines.push(`*生成时间: ${c.generatedAt}*`);
  return lines.join("\n");
}

/** 把 markdown 写入仓库根目录的 AGENT.md，返回绝对路径。 */
export function writeContextFile(root: string, md: string): string {
  const path = resolve(root, CONTEXT_FILE_NAME);
  writeFileSync(path, md, "utf-8");
  return path;
}

/** 读取已存在的 AGENT.md（若存在），否则返回 null。 */
export function loadContextFile(root: string): string | null {
  const path = resolve(root, CONTEXT_FILE_NAME);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}
