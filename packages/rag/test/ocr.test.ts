import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanOcrText,
  FakeOcrProvider,
  isLikelyScanned,
  normalizeOcrDecision,
  NoopOcrProvider,
} from "../src/ocr.js";

test("isLikelyScanned 按每页平均字符数判定", () => {
  assert.equal(isLikelyScanned(0, 3, 50), true);
  assert.equal(isLikelyScanned(10, 2, 50), true);
  assert.equal(isLikelyScanned(500, 2, 50), false);
  assert.equal(isLikelyScanned(100, 0, 50), false);
  // 边界：恰好等于阈值不算扫描
  assert.equal(isLikelyScanned(100, 2, 50), false);
});

test("normalizeOcrDecision 非法值回退默认", () => {
  const d = normalizeOcrDecision({ enabled: true, minCharsPerPage: NaN, maxPagesSync: -3 });
  assert.equal(d.enabled, true);
  assert.equal(d.minCharsPerPage, 50);
  assert.equal(d.maxPagesSync, 10);
});

test("cleanOcrText 去连字符/碎行/多空白", () => {
  assert.equal(cleanOcrText("hyphena-\ntion"), "hyphenation");
  // CJK 碎行拼接
  assert.equal(cleanOcrText("合同编号\nABC123"), "合同编号 ABC123");
  assert.equal(cleanOcrText("知识库\n检索增强"), "知识库检索增强");
  // 多空白归一
  assert.equal(cleanOcrText("hello   world"), "hello world");
  assert.equal(cleanOcrText(""), "");
});

test("Noop/Fake provider 行为", async () => {
  const noop = new NoopOcrProvider();
  assert.deepEqual(await noop.extract(new Uint8Array([1, 2])), []);
  const fake = new FakeOcrProvider(["第一页内容", "第二页\n内容"]);
  const pages = await fake.extract(new Uint8Array([1]));
  assert.equal(pages.length, 2);
  assert.equal(pages[0]?.pageNumber, 1);
  assert.ok((pages[0]?.text.length ?? 0) > 0);
});
