import { describe, expect, it } from "vitest";
import {
  REPORT_STATUS_LABELS,
  describeSchedule,
  formatCellValue,
  formatDateTime,
  formatDuration,
  isValidTimeOfDay,
} from "./schedule.js";

describe("reports schedule helpers", () => {
  it("describes daily and weekly schedules", () => {
    expect(describeSchedule({ frequency: "daily", time: "09:00" })).toBe("每天 09:00");
    expect(describeSchedule({ frequency: "weekly", time: "08:30", weekday: 1 })).toBe(
      "每周一 08:30",
    );
    expect(describeSchedule({ frequency: "weekly", time: "20:00" })).toBe("每周日 20:00");
  });

  it("validates HH:MM input", () => {
    expect(isValidTimeOfDay("09:00")).toBe(true);
    expect(isValidTimeOfDay("23:59")).toBe(true);
    expect(isValidTimeOfDay("24:00")).toBe(false);
    expect(isValidTimeOfDay("9:00")).toBe(false);
    expect(isValidTimeOfDay("")).toBe(false);
  });

  it("formats durations, timestamps and cells", () => {
    expect(formatDuration(420)).toBe("420 ms");
    expect(formatDuration(1_500)).toBe("1.5 s");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("2026-10-19T09:00:00.000Z")).toMatch(/^2026-10-19 \d{2}:\d{2}$/);
    expect(formatCellValue(null)).toBe("—");
    expect(formatCellValue(12)).toBe("12");
    expect(formatCellValue({ a: 1 })).toBe('{"a":1}');
  });

  it("labels every run status", () => {
    expect(REPORT_STATUS_LABELS.succeeded).toBe("成功");
    expect(REPORT_STATUS_LABELS.clarifying).toBe("需补充口径");
  });
});
