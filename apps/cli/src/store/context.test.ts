import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  CONTEXT_FILE_NAME,
  LEGACY_CONTEXT_FILE_NAME,
  contextToMarkdown,
  generateProjectContext,
  loadContextFile,
  writeContextFile,
} from "./context.ts";

test("项目上下文优先 AGENTS.md 并兼容 AGENT.md", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cli-context-"));
  try {
    await writeFile(join(cwd, LEGACY_CONTEXT_FILE_NAME), "legacy", "utf8");
    assert.equal(loadContextFile(cwd), "legacy");

    const path = writeContextFile(cwd, "current");
    assert.equal(basename(path), CONTEXT_FILE_NAME);
    assert.equal(loadContextFile(cwd), "current");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("项目上下文继承仓库根忽略规则且支持反向规则", async () => {
  const repo = await mkdtemp(join(tmpdir(), "cli-context-repo-"));
  const cwd = join(repo, "apps", "cli");
  try {
    await mkdir(join(repo, ".git"));
    await mkdir(join(cwd, ".open-agent-tools"), { recursive: true });
    await writeFile(
      join(repo, ".gitignore"),
      [".env.*", "!.env.example", "apps/cli/mcp.json", "*.sqlite", ".open-agent-tools"].join("\n"),
      "utf8",
    );
    await writeFile(join(cwd, ".env.local"), "SECRET=value", "utf8");
    await writeFile(join(cwd, ".env.example"), "SAFE=placeholder", "utf8");
    await writeFile(join(cwd, "mcp.json"), '{"token":"secret"}', "utf8");
    await writeFile(join(cwd, "chat.sqlite"), "local", "utf8");
    await writeFile(join(cwd, ".open-agent-tools", "index.sqlite"), "local", "utf8");
    await writeFile(join(cwd, "visible.ts"), "export {};", "utf8");

    const context = generateProjectContext(cwd);
    assert.match(context.tree, /\.env\.example/);
    assert.match(context.tree, /visible\.ts/);
    assert.doesNotMatch(context.tree, /\.env\.local|mcp\.json|chat\.sqlite|\.open-agent-tools/);
    assert.deepEqual(
      context.keyFiles.map((file) => file.path),
      [".env.example"],
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("关键文件中的代码块不会提前闭合项目上下文 fence", () => {
  const markdown = contextToMarkdown({
    root: "/tmp/example",
    name: "example",
    techStack: [],
    fileCount: 1,
    languageBreakdown: [],
    tree: "example\n└── README.md",
    keyFiles: [{ path: "README.md", content: "before\n```ts\nconst ok = true;\n```\nafter" }],
    generatedAt: "2026-08-11T00:00:00.000Z",
  });

  assert.match(markdown, /````\nbefore\n```ts\nconst ok = true;\n```\nafter\n````/);
});
