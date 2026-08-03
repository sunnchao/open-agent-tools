import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
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
