import { ENTRIES, EXTRA, SYLLABLES } from "./dictionary.js";
import { PHRASES } from "./phrases.js";

const SYLLABLE_LIST = SYLLABLES.split(",");
const READINGS = new Map();

let codePoint = 0x4dff;
for (const token of ENTRIES.split(",")) {
  const packed = Number.parseInt(token, 36);
  codePoint += packed >>> 12;
  READINGS.set(codePoint, [SYLLABLE_LIST[(packed >>> 3) & 0x1ff], packed & 0x7]);
}

for (const [char, [index, tone]] of Object.entries(EXTRA)) {
  READINGS.set(char.codePointAt(0), [SYLLABLE_LIST[index], tone]);
}

const TONE_MARKS = {
  a: "āáǎàa",
  e: "ēéěèe",
  i: "īíǐìi",
  o: "ōóǒòo",
  u: "ūúǔùu",
  v: "ǖǘǚǜü",
};

export function lookupReading(char) {
  const reading = READINGS.get(char.codePointAt(0));
  return reading ? { syllable: reading[0], tone: reading[1] } : null;
}

const PHRASES_BY_FIRST = new Map();
for (const phrase of Object.keys(PHRASES)) {
  const first = phrase[0];
  const group = PHRASES_BY_FIRST.get(first);
  if (group) group.push(phrase);
  else PHRASES_BY_FIRST.set(first, [phrase]);
}
for (const group of PHRASES_BY_FIRST.values()) {
  group.sort((left, right) => right.length - left.length);
}

function readingFromToken(token) {
  const match = /^([a-z]+)([1-5])$/.exec(token);
  if (!match) return null;
  return { syllable: match[1], tone: Number(match[2]) };
}

function matchPhrase(chars, start) {
  const group = PHRASES_BY_FIRST.get(chars[start]);
  if (!group) return null;
  const remaining = chars.length - start;
  for (const phrase of group) {
    const size = [...phrase].length;
    if (size > remaining) continue;
    if (chars.slice(start, start + size).join("") !== phrase) continue;
    const tokens = PHRASES[phrase].split(" ").map(readingFromToken);
    if (tokens.length === size && tokens.every(Boolean)) return tokens;
  }
  return null;
}

function applyToneMark(syllable, tone) {
  if (tone < 1 || tone > 4) return syllable.replaceAll("v", "ü");
  const vowel = syllable.includes("a")
    ? "a"
    : syllable.includes("e")
      ? "e"
      : syllable.includes("ou")
        ? "o"
        : [...syllable].reverse().find((letter) => "aeiouv".includes(letter));
  if (!vowel) return syllable;
  return syllable.replace(vowel, TONE_MARKS[vowel][tone - 1]).replaceAll("v", "ü");
}

function formatSyllable(reading, { tone, toneType }) {
  if (!tone) return reading.syllable.replaceAll("v", "u");
  if (toneType === "mark") return applyToneMark(reading.syllable, reading.tone);
  return `${reading.syllable.replaceAll("v", "u")}${reading.tone === 5 ? 0 : reading.tone}`;
}

export function toPinyin(text, options = {}) {
  const separator = options.separator ?? "";
  const tone = options.tone ?? false;
  const toneType = options.toneType ?? "num";
  const parts = [];
  let plain = "";

  const flush = () => {
    if (!plain) return;
    parts.push(plain.trim());
    plain = "";
  };

  const chars = [...text];
  for (let index = 0; index < chars.length; index += 1) {
    const phrase = matchPhrase(chars, index);
    if (phrase) {
      flush();
      for (const reading of phrase) parts.push(formatSyllable(reading, { tone, toneType }));
      index += phrase.length - 1;
      continue;
    }

    const reading = lookupReading(chars[index]);
    if (!reading) {
      plain += chars[index];
      continue;
    }
    flush();
    parts.push(formatSyllable(reading, { tone, toneType }));
  }
  flush();
  return parts.join(separator);
}

const MAX_TEXT_LENGTH = 200;

export function normalizePinyinArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("arguments must be an object");
  }

  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text || text.length > MAX_TEXT_LENGTH) {
    throw new Error(`text must be 1-${MAX_TEXT_LENGTH} characters`);
  }

  const separator = args.separator ?? "";
  if (typeof separator !== "string" || separator.length > 8) {
    throw new Error("separator must be a string of at most 8 characters");
  }

  const tone = args.tone ?? false;
  if (typeof tone !== "boolean") {
    throw new Error("tone must be a boolean");
  }

  return { text, separator, tone };
}

export function convertChineseToPinyin(args) {
  const request = normalizePinyinArgs(args);
  const pinyin = toPinyin(request.text, request);
  return {
    content: [{ type: "text", text: pinyin }],
    structuredContent: {
      text: request.text,
      pinyin,
      separator: request.separator,
      tone: request.tone,
    },
    isError: false,
  };
}
