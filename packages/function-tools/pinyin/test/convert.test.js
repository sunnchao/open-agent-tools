import assert from "node:assert/strict";
import test from "node:test";
import { handlers } from "../src/index.js";
import { convertChineseToPinyin, normalizePinyinArgs, toPinyin } from "../src/convert.js";

test("converts a city name to unspaced pinyin", () => {
  assert.equal(toPinyin("北京"), "beijing");
  assert.equal(toPinyin("上海"), "shanghai");
  assert.equal(toPinyin("重庆"), "chongqing");
  assert.equal(toPinyin("重"), "zhong");
});

test("preserves non-Chinese characters and honors separators and tones", () => {
  assert.equal(toPinyin("北京 Beijing", { separator: " " }), "bei jing Beijing");
  assert.equal(toPinyin("北京", { separator: "-", tone: true }), "bei3-jing1");
  assert.equal(toPinyin("绿", { tone: true, toneType: "mark" }), "lǜ");
});

test("normalizes documented defaults and rejects invalid arguments", () => {
  assert.deepEqual(normalizePinyinArgs({ text: " 北京 " }), {
    text: "北京",
    separator: "",
    tone: false,
  });
  assert.throws(() => normalizePinyinArgs({ text: " " }), /text must be 1-200 characters/);
  assert.throws(() => normalizePinyinArgs({ text: "北京", tone: "yes" }), /tone must be a boolean/);
});

test("returns the pinyin string as tool text", () => {
  const result = convertChineseToPinyin({ text: "北京" });
  assert.equal(result.isError, false);
  assert.equal(result.content[0].text, "beijing");
  assert.equal(result.structuredContent.pinyin, "beijing");
});

test("reports invalid arguments without throwing from the managed handler", async () => {
  const result = await handlers.chineseToPinyin({ text: "" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /text must be 1-200 characters/);
});
