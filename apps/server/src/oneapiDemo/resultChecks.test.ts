import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { closeDb, openDb } from "../db.js";
import {
  assessQueryResult,
  median,
  numericMediansOf,
  summarizeAssessment,
  type QueryResultBaseline,
} from "./resultChecks.js";
import { loadResultBaseline, questionKeyOf, recordResultBaseline } from "./resultBaselines.js";

function baseline(partial: Partial<QueryResultBaseline>): QueryResultBaseline {
  return {
    rowCount: partial.rowCount ?? 100,
    numericMedians: partial.numericMedians ?? {},
    capturedAt: partial.capturedAt ?? "2026-10-18T00:00:00.000Z",
  };
}

describe("assessQueryResult", () => {
  it("warns on an empty result set", () => {
    const assessment = assessQueryResult({ rows: [] });
    assert.equal(assessment.level, "warning");
    assert.deepEqual(
      assessment.checks.map((check) => check.code),
      ["empty_result"],
    );
  });

  it("treats truncation as an informational note, not an error", () => {
    const assessment = assessQueryResult({
      rows: [{ total: 1 }],
      truncated: true,
    });
    assert.equal(assessment.level, "info");
    assert.deepEqual(
      assessment.checks.map((check) => check.code),
      ["truncated"],
    );
  });

  it("flags an all-null column separately from a partially-null column", () => {
    const assessment = assessQueryResult({
      rows: [
        { amount: null, owner: null },
        { amount: null, owner: "alice" },
      ],
    });
    const codes = assessment.checks.map((check) => check.code);
    assert.ok(codes.includes("all_null_column"));
    assert.ok(codes.includes("high_null_ratio"));
    const allNull = assessment.checks.find((check) => check.code === "all_null_column");
    assert.equal(allNull?.column, "amount");
    const highNull = assessment.checks.find((check) => check.code === "high_null_ratio");
    assert.equal(highNull?.column, "owner");
    assert.equal(highNull?.level, "info");
  });

  it("warns when row count deviates far from a large enough baseline", () => {
    const grown = assessQueryResult({
      rows: Array.from({ length: 600 }, () => ({ id: 1 })),
      baseline: baseline({ rowCount: 100 }),
    });
    const check = grown.checks.find((item) => item.code === "row_count_shift");
    assert.equal(check?.level, "warning");
    assert.equal(check?.detail?.baselineRowCount, 100);
    assert.equal(check?.detail?.ratio, 6);

    const shrunk = assessQueryResult({
      rows: Array.from({ length: 5 }, () => ({ id: 1 })),
      baseline: baseline({ rowCount: 500 }),
    });
    assert.ok(shrunk.checks.some((item) => item.code === "row_count_shift"));
  });

  it("ignores row-count noise when the baseline sample is small", () => {
    const assessment = assessQueryResult({
      rows: Array.from({ length: 60 }, () => ({ id: 1 })),
      baseline: baseline({ rowCount: 10 }),
    });
    assert.equal(
      assessment.checks.some((item) => item.code === "row_count_shift"),
      false,
    );
  });

  it("warns when a numeric column changes order of magnitude", () => {
    const assessment = assessQueryResult({
      rows: [{ amount: 2000 }, { amount: 2200 }],
      baseline: baseline({ numericMedians: { amount: 100 } }),
    });
    const check = assessment.checks.find((item) => item.code === "magnitude_shift");
    assert.equal(check?.level, "warning");
    assert.equal(check?.column, "amount");
    assert.equal(check?.detail?.ratio, 21);
  });

  it("never divides by a zero baseline and stays quiet without a baseline", () => {
    const zeroBaseline = assessQueryResult({
      rows: [{ amount: 5 }],
      baseline: baseline({ rowCount: 1, numericMedians: { amount: 0 } }),
    });
    assert.equal(
      zeroBaseline.checks.some((item) => item.code === "magnitude_shift"),
      false,
    );

    const noBaseline = assessQueryResult({ rows: [{ amount: 5 }, { amount: 900000 }] });
    assert.equal(noBaseline.checks.length, 0);
  });

  it("keeps check order stable for identical input", () => {
    const rows = [
      { id: 1, amount: null },
      { id: 2, amount: null },
    ];
    const first = assessQueryResult({
      rows,
      truncated: true,
      baseline: baseline({ rowCount: 100 }),
    });
    const second = assessQueryResult({
      rows,
      truncated: true,
      baseline: baseline({ rowCount: 100 }),
    });
    assert.deepEqual(first, second);
  });
});

describe("numeric helpers", () => {
  it("computes medians for odd and even sample sizes", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), null);
  });

  it("only treats true numbers and plain numeric strings as numbers", () => {
    const medians = numericMediansOf([
      { amount: "10", id: "ORDER-1", code: "1,000", flag: true },
      { amount: 30, id: "ORDER-2", code: "1,000", flag: false },
    ]);
    assert.deepEqual(medians, { amount: 20 });
  });

  it("builds a compact summary only when there are findings", () => {
    assert.equal(summarizeAssessment({ level: "info", checks: [] }), null);
    const summary = summarizeAssessment(assessQueryResult({ rows: [], truncated: true }));
    assert.equal(summary, "结果校验:1 项预警 / 1 项提示");
  });
});

describe("result baselines", () => {
  let dir: string;
  const previousPath = process.env.SQLITE_PATH;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "result-baseline-"));
    process.env.SQLITE_PATH = join(dir, "baseline.sqlite");
    openDb();
  });

  after(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
    if (previousPath === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = previousPath;
  });

  it("normalizes questions into a stable key", () => {
    assert.equal(questionKeyOf(" 查看 用户  "), "查看用户");
    assert.equal(questionKeyOf("SHOW USERS"), "showusers");
  });

  it("round-trips a baseline and updates it in place", () => {
    assert.equal(loadResultBaseline("source-a", "查看用户"), null);
    recordResultBaseline("source-a", "查看用户", [{ amount: 10 }, { amount: 30 }]);
    const first = loadResultBaseline("source-a", " 查看用户 ");
    assert.equal(first?.rowCount, 2);
    assert.equal(first?.numericMedians.amount, 20);
    assert.ok(first?.capturedAt);

    recordResultBaseline("source-a", "查看用户", [{ amount: 100 }, { amount: 100 }]);
    const second = loadResultBaseline("source-a", "查看用户");
    assert.equal(second?.rowCount, 2);
    assert.equal(second?.numericMedians.amount, 100);
  });

  it("keeps baselines isolated per source", () => {
    recordResultBaseline("source-b", "查看用户", [{ amount: 7 }]);
    const sourceB = loadResultBaseline("source-b", "查看用户");
    assert.equal(sourceB?.numericMedians.amount, 7);
    const sourceA = loadResultBaseline("source-a", "查看用户");
    assert.equal(sourceA?.numericMedians.amount, 100);
  });
});
