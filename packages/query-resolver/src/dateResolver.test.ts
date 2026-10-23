import { test } from "node:test";
import assert from "node:assert/strict";
import { lastMonthPeriod, resolveDate, thisMonthPeriod } from "./resolvers/dateResolver.js";

test("日历区间使用请求时区，不依赖服务器时区", () => {
  const original = process.env.TZ;
  try {
    for (const serverZone of ["UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
      process.env.TZ = serverZone;
      const now = new Date("2026-10-31T16:30:00Z");
      assert.deepEqual(thisMonthPeriod(now), {
        start: "2026-11-01",
        end: "2026-11-30",
        tz: "Asia/Shanghai",
      });
      assert.deepEqual(lastMonthPeriod(now), {
        start: "2026-10-01",
        end: "2026-10-31",
        tz: "Asia/Shanghai",
      });
      assert.deepEqual(thisMonthPeriod(now, "America/New_York"), {
        start: "2026-10-01",
        end: "2026-10-31",
        tz: "America/New_York",
      });
      const boundary = new Date("2025-12-31T16:30:00Z");
      const expected = [
        ["本季度", "2026-01-01", "2026-03-31"],
        ["上季度", "2025-10-01", "2025-12-31"],
        ["上上个月", "2025-11-01", "2025-11-30"],
        ["去年", "2025-01-01", "2025-12-31"],
        ["前年", "2024-01-01", "2024-12-31"],
        ["最近3天", "2025-12-30", "2026-01-01"],
        ["2024年2月", "2024-02-01", "2024-02-29"],
      ];
      for (const [raw, start, end] of expected) {
        assert.deepEqual(
          resolveDate(raw, boundary).value,
          { start, end, tz: "Asia/Shanghai" },
          `${serverZone}: ${raw}`,
        );
      }
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("最近天数按目标时区的日历跨越夏令时和闰日", () => {
  assert.deepEqual(
    resolveDate("最近3天", new Date("2026-03-09T04:30:00Z"), "America/New_York").value,
    {
      start: "2026-03-07",
      end: "2026-03-09",
      tz: "America/New_York",
    },
  );
  assert.deepEqual(resolveDate("最近2天", new Date("2024-02-29T16:30:00Z")).value, {
    start: "2024-02-29",
    end: "2024-03-01",
    tz: "Asia/Shanghai",
  });
});
