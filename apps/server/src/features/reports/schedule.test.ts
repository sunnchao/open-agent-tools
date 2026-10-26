import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeSchedule,
  nextRunAt,
  parseReportSchedule,
  parseTimeOfDay,
} from "./schedule.js";

describe("报表周期解析", () => {
  it("只接受 HH:MM 24 小时制", () => {
    assert.deepEqual(parseTimeOfDay("09:05"), { hour: 9, minute: 5 });
    assert.deepEqual(parseTimeOfDay("23:59"), { hour: 23, minute: 59 });
    assert.equal(parseTimeOfDay("24:00"), null);
    assert.equal(parseTimeOfDay("9:00"), null);
    assert.equal(parseTimeOfDay("09:60"), null);
    assert.equal(parseTimeOfDay(""), null);
  });

  it("daily 忽略 weekday,weekly 必须给出 0-6", () => {
    const daily = parseReportSchedule({ frequency: "daily", time: "09:00", weekday: 5 });
    assert.deepEqual(daily, { ok: true, value: { frequency: "daily", time: "09:00" } });

    const weekly = parseReportSchedule({ frequency: "weekly", time: "08:30", weekday: 1 });
    assert.deepEqual(weekly, {
      ok: true,
      value: { frequency: "weekly", time: "08:30", weekday: 1 },
    });

    assert.deepEqual(parseReportSchedule({ frequency: "hourly", time: "09:00" }), {
      ok: false,
      error: "frequency 必须为 daily 或 weekly",
    });
    assert.deepEqual(parseReportSchedule({ frequency: "weekly", time: "08:30" }), {
      ok: false,
      error: "weekly 周期必须提供 weekday(0=周日 .. 6=周六)",
    });
    assert.equal(
      parseReportSchedule({ frequency: "weekly", time: "08:30", weekday: 7 }).ok,
      false,
    );
    assert.equal(parseReportSchedule({ frequency: "daily", time: "25:00" }).ok, false);
  });
});

describe("下一次执行时刻", () => {
  const daily = { frequency: "daily" as const, time: "09:00" };

  it("同一天未到点取当天,已到点顺延到次日", () => {
    assert.equal(
      new Date(nextRunAt(daily, Date.parse("2026-03-01T08:00:00Z"))).toISOString(),
      "2026-03-01T09:00:00.000Z",
    );
    assert.equal(
      new Date(nextRunAt(daily, Date.parse("2026-03-01T09:00:00Z"))).toISOString(),
      "2026-03-02T09:00:00.000Z",
    );
    assert.equal(
      new Date(nextRunAt(daily, Date.parse("2026-03-01T23:30:00Z"))).toISOString(),
      "2026-03-02T09:00:00.000Z",
    );
  });

  it("weekly 命中目标星期,当天已过则顺延一周", () => {
    const weekly = { frequency: "weekly" as const, time: "09:00", weekday: 1 };
    // 2026-03-01 是周日,下一个周一为 2026-03-02。
    assert.equal(
      new Date(nextRunAt(weekly, Date.parse("2026-03-01T12:00:00Z"))).toISOString(),
      "2026-03-02T09:00:00.000Z",
    );
    assert.equal(
      new Date(nextRunAt(weekly, Date.parse("2026-03-02T10:00:00Z"))).toISOString(),
      "2026-03-09T09:00:00.000Z",
    );
  });

  it("偏移量把墙上时间换算成 UTC", () => {
    // UTC+8 的 09:00 对应 UTC 01:00。
    assert.equal(
      new Date(nextRunAt(daily, Date.parse("2026-03-01T00:30:00Z"), 480)).toISOString(),
      "2026-03-01T01:00:00.000Z",
    );
  });

  it("描述文案与解析结果一致", () => {
    assert.equal(describeSchedule(daily), "每天 09:00");
    assert.equal(
      describeSchedule({ frequency: "weekly", time: "08:30", weekday: 2 }),
      "每周二 08:30",
    );
  });
});
