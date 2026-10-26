import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contentDisposition,
  escapeCsvValue,
  exportFilename,
  serializeCsv,
  timestampSegment,
  type CsvColumn,
} from "./csv.js";

interface Row {
  name: string;
  note: string;
}

const columns: Array<CsvColumn<Row>> = [
  { header: "名称", value: (row) => row.name },
  { header: "备注", value: (row) => row.note },
];

describe("CSV serialization", () => {
  it("quotes fields containing commas, quotes, CR or LF and doubles inner quotes", () => {
    assert.equal(escapeCsvValue("plain"), "plain");
    assert.equal(escapeCsvValue("a,b"), '"a,b"');
    assert.equal(escapeCsvValue('say "hi"'), '"say ""hi"""');
    assert.equal(escapeCsvValue("line1\nline2"), '"line1\nline2"');
    assert.equal(escapeCsvValue("line1\r\nline2"), '"line1\r\nline2"');
    assert.equal(escapeCsvValue("报表,2026"), '"报表,2026"');
    assert.equal(escapeCsvValue(null), "");
    assert.equal(escapeCsvValue(undefined), "");
    assert.equal(escapeCsvValue(42), "42");
  });

  it("writes a UTF-8 BOM and CRLF line endings", () => {
    const csv = serializeCsv(columns, [
      { name: "报表,2026", note: '含"引号"' },
      { name: "第二行", note: "换行\n也转义" },
    ]);
    assert.ok(csv.startsWith("\ufeff"));
    const lines = csv.slice(1).split("\r\n");
    assert.equal(lines[0], "名称,备注");
    assert.equal(lines[1], '"报表,2026","含""引号"""');
    assert.equal(lines[2], '第二行,"换行\n也转义"');
    // 末尾补一个行尾,最后一段应为空串。
    assert.equal(lines.at(-1), "");
  });

  it("omits the BOM when explicitly disabled", () => {
    const csv = serializeCsv(columns, [{ name: "a", note: "b" }], { bom: false });
    assert.equal(csv.startsWith("\ufeff"), false);
    assert.equal(csv, "名称,备注\r\na,b\r\n");
  });
});

describe("export filename safety", () => {
  it("keeps only ASCII whitelist characters in the base name and always appends a timestamp", () => {
    const name = exportFilename('usage";x\r\n<script>', "csv", new Date("2026-10-19T01:02:03Z"));
    assert.equal(name, "usage-x-script-20261019-010203.csv");
    assert.match(name, /^[A-Za-z0-9._-]+$/);
  });

  it("sanitizes header-injection characters and falls back when nothing usable remains", () => {
    const injected = exportFilename("审计/../\r\n", "json", new Date("2026-01-02T03:04:05Z"));
    assert.match(injected, /^[A-Za-z0-9._-]+$/);
    assert.equal(injected.endsWith(".json"), true);
    assert.equal(
      exportFilename("***", "csv", new Date("2026-01-02T03:04:05Z")),
      "export-20260102-030405.csv",
    );
  });

  it("formats timestamps in UTC and builds an attachment header without CRLF", () => {
    assert.equal(timestampSegment(new Date("2026-10-19T01:02:03Z")), "20261019-010203");
    const header = contentDisposition("usage-events-20261019-010203.csv");
    assert.equal(header, 'attachment; filename="usage-events-20261019-010203.csv"');
    assert.equal(/[\r\n]/.test(header), false);
  });
});
