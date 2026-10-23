import assert from "node:assert/strict";
import fs, {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore, buildMemoryContext } from "./memory.ts";

const cleanups: string[] = [];

function createStore(): MemoryStore {
  const root = mkdtempSync(join(tmpdir(), "open-agent-tools-memory-"));
  cleanups.push(root);
  const store = new MemoryStore({
    cwd: join(root, "project"),
    globalRoot: join(root, "global"),
    projectRoot: join(root, "project-memory"),
  });
  store.open();
  return store;
}

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  it("avoids per-entry SQL and repeated Markdown reads during search", (t) => {
    const store = createStore();
    t.after(() => store.close());
    for (let i = 0; i < 40; i += 1) {
      store.write({
        slug: `entry-${i}`,
        scope: i % 2 === 0 ? "project" : "global",
        type: "project",
        description: "记忆索引",
        body: `包含中文规则和 keyword ${i}`,
        actor: "user",
      });
    }
    const reads = t.mock.method(fs, "readFileSync");
    const prepares = t.mock.method(DatabaseSync.prototype, "prepare");
    syncBuiltinESMExports();
    t.after(() => {
      reads.mock.restore();
      syncBuiltinESMExports();
    });
    t.mock.method(Date, "now", () => 1_800_000_000_000);
    const markdownReads = () =>
      reads.mock.calls.filter((call) => String(call.arguments[0]).endsWith(".md")).length;

    const cold = store.search("keyword", { limit: 40 });
    assert.equal(cold.length, 40);
    assert.equal(markdownReads(), 40);
    const warm = store.search("keyword", { limit: 40 });
    assert.deepEqual(warm, cold);
    assert.equal(markdownReads(), 40, "unchanged entries should reuse parsed Markdown");
    const chinese = store.search("中文", { limit: 40 });
    assert.equal(chinese.length, 40);
    assert.ok(chinese.every((match) => match.matchedBy.includes("body")));
    assert.equal(markdownReads(), 40);
    assert.equal(
      prepares.mock.calls.filter((call) => String(call.arguments[0]).includes("slug = ?")).length,
      0,
    );
  });

  it("refreshes cached entries after same-size edits, replacement, deletion and repair", (t) => {
    const store = createStore();
    t.after(() => store.close());
    const written = store.write({
      slug: "editable",
      scope: "project",
      type: "project",
      description: "文件编辑",
      body: "旧版正文",
      actor: "user",
    });
    const path = written.meta.filePath;
    const original = readFileSync(path, "utf8");
    assert.equal(store.read("editable")?.body, "旧版正文");
    const oldStat = statSync(path);
    writeFileSync(path, original.replace("旧版正文", "新版正文"));
    utimesSync(path, oldStat.atime, oldStat.mtime);
    assert.equal(store.search("新版")[0]?.body, "新版正文");

    const replacement = `${path}.replacement`;
    writeFileSync(replacement, original.replace("旧版正文", "替换正文"));
    utimesSync(replacement, oldStat.atime, oldStat.mtime);
    renameSync(replacement, path);
    assert.equal(store.search("替换")[0]?.body, "替换正文");
    writeFileSync(path, "invalid markdown");
    assert.equal(store.read("editable"), null);
    writeFileSync(path, original);
    assert.equal(store.read("editable")?.body, "旧版正文");
    rmSync(path);
    assert.equal(store.read("editable"), null);
    assert.deepEqual(store.search("正文"), []);
    writeFileSync(path, original);
    assert.equal(store.read("editable")?.body, "旧版正文");
  });

  it("does not expose cached metadata to caller mutations and refreshes internal writes", (t) => {
    const store = createStore();
    t.after(() => store.close());
    const input = {
      slug: "mutable",
      scope: "project",
      type: "project",
      description: "原始说明",
      body: "原始正文",
      actor: "user",
      links: ["reference"],
    } as const;
    store.write({ ...input, links: [...input.links] });
    const entry = store.read(input.slug);
    assert.ok(entry);
    entry.body = "污染正文";
    entry.meta.links.push("polluted");
    entry.meta.source.actor = "tool";
    assert.equal(store.read(input.slug)?.body, "原始正文");
    assert.deepEqual(store.read(input.slug)?.meta.links, ["reference"]);
    assert.equal(store.read(input.slug)?.meta.source.actor, "user");
    store.write({ ...input, links: [], body: "修改正文" });
    assert.equal(store.read(input.slug)?.body, "修改正文");
    store.remove(input.slug);
    assert.equal(store.read(input.slug), null);
    store.write({ ...input, links: [], body: "重建正文" });
    assert.equal(store.read(input.slug)?.body, "重建正文");
    store.wipeAll("project");
    assert.equal(store.read(input.slug), null);
  });

  it("persists a proposal and only recalls it after acceptance", () => {
    const store = createStore();
    const result = store.write({
      slug: "prefer-typescript",
      scope: "project",
      type: "project",
      description: "项目优先使用 TypeScript",
      headline: "TypeScript 约定",
      body: "新增代码应使用 TypeScript，并保持 strict 模式。",
      actor: "tool",
      unreviewed: true,
    });

    assert.equal(result.meta.unreviewed, true);
    assert.equal(store.search("TypeScript").length, 0);

    store.accept("prefer-typescript", "project");
    const matches = store.search("TypeScript");
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.meta.slug, "prefer-typescript");
    assert.equal(matches[0]?.meta.unreviewed, false);
    store.close();
  });

  it("finds two-character Chinese queries through substring fallback", () => {
    const store = createStore();
    store.write({
      slug: "chinese-replies",
      scope: "global",
      type: "user",
      description: "用户偏好中文回复",
      headline: "中文回复",
      body: "技术讨论默认使用简体中文。",
      actor: "user",
      unreviewed: false,
    });

    const matches = store.search("中文");
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.meta.slug, "chinese-replies");
    store.close();
  });

  it("rolls daily memory before the configured hour", () => {
    const store = createStore();
    const entry = store.appendDaily("完成 memory 核心存储", {
      scope: "project",
      actor: "user",
      now: new Date(2026, 6, 31, 3, 30),
    });

    assert.equal(entry.meta.slug, "daily-2026-07-30");
    assert.match(entry.body, /完成 memory 核心存储/);
    store.close();
  });

  it("does not let a proposal overwrite an accepted memory", () => {
    const store = createStore();
    store.write({
      slug: "stable-rule",
      scope: "project",
      type: "project",
      description: "稳定规则",
      body: "可信正文",
      actor: "user",
      unreviewed: false,
    });

    assert.throws(
      () =>
        store.write({
          slug: "stable-rule",
          scope: "project",
          type: "project",
          description: "覆盖提议",
          body: "不可信正文",
          actor: "tool",
          unreviewed: true,
        }),
      /不能用待审核提议覆盖可信记忆/,
    );
    assert.equal(store.read("stable-rule", "project")?.body, "可信正文");
    store.close();
  });

  it("removes stale index rows during reindex and supports CRLF files", () => {
    const store = createStore();
    const written = store.write({
      slug: "crlf-entry",
      scope: "project",
      type: "project",
      description: "CRLF 记忆",
      body: "正文内容",
      actor: "user",
      unreviewed: false,
    });
    const content = readFileSync(written.meta.filePath, "utf8");
    writeFileSync(written.meta.filePath, content.replace(/\n/g, "\r\n"), "utf8");
    store.reindex();
    assert.equal(store.read("crlf-entry", "project")?.body, "正文内容");

    rmSync(written.meta.filePath);
    store.reindex();
    assert.equal(store.list({ includeUnreviewed: true }).length, 0);
    store.close();
  });

  it("keeps tool-written daily entries pending review", () => {
    const store = createStore();
    const entry = store.appendDaily("模型提议的日志", {
      scope: "project",
      actor: "tool",
      now: new Date(2026, 6, 31, 12, 0),
    });
    assert.equal(entry.meta.unreviewed, true);
    assert.match(entry.meta.slug, /^daily-2026-07-31-proposal-/);
    assert.equal(store.search("模型提议").length, 0);
    store.close();
  });

  it("injects reviewed memory into a bounded prompt context", () => {
    const store = createStore();
    store.write({
      slug: "pnpm-build",
      scope: "project",
      type: "project",
      description: "项目使用 pnpm 构建",
      headline: "pnpm 构建约定",
      body: "验证时执行 pnpm typecheck 和 pnpm build。",
      actor: "user",
      unreviewed: false,
    });

    const context = buildMemoryContext(store, "pnpm", { maxChars: 1_000 });
    assert.match(context, /相关长期记忆/);
    assert.match(context, /pnpm 构建约定/);
    assert.match(context, /slug: pnpm-build/);
    store.close();
  });

  it("returns empty context when no entry fits the budget", () => {
    const store = createStore();
    store.write({
      slug: "pnpm-build",
      scope: "project",
      type: "project",
      description: "项目使用 pnpm 构建",
      headline: "pnpm 构建约定",
      body: "验证时执行 pnpm typecheck 和 pnpm build。".repeat(10),
      actor: "user",
      unreviewed: false,
    });

    assert.equal(buildMemoryContext(store, "pnpm", { maxChars: 150 }), "");
    store.close();
  });

  it("skips an oversized entry but keeps later entries within budget", () => {
    const store = createStore();
    store.write({
      slug: "long-entry",
      scope: "project",
      type: "project",
      description: "pnpm 长记忆",
      headline: "pnpm 长记忆",
      body: "pnpm 细节。".repeat(120),
      actor: "user",
      unreviewed: false,
    });
    store.write({
      slug: "short-entry",
      scope: "project",
      type: "project",
      description: "pnpm 短记忆",
      headline: "pnpm 短记忆",
      body: "pnpm 用于构建。",
      actor: "user",
      unreviewed: false,
    });

    const context = buildMemoryContext(store, "pnpm", { maxChars: 400 });
    assert.match(context, /pnpm 短记忆/);
    assert.doesNotMatch(context, /pnpm 长记忆/);
    assert.ok(context.length <= 400);
    store.close();
  });

  it("recalls memories from long Chinese queries without spaces", () => {
    const store = createStore();
    store.write({
      slug: "login-page-style",
      scope: "project",
      type: "project",
      description: "登录页面使用 Tailwind 编写样式",
      headline: "登录页面样式约定",
      body: "登录页面组件位于 src/pages/Login.tsx，样式统一使用 Tailwind。",
      actor: "user",
      unreviewed: false,
    });

    const matches = store.search("帮我调整一下登录页面的按钮样式");
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.meta.slug, "login-page-style");
    store.close();
  });
});
