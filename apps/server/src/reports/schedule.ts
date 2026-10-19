/**
 * 定时报表的周期计算(纯函数,无 IO)。
 *
 * MVP 只支持「每天 HH:MM」与「每周几 HH:MM」两种周期:足以表达
 * 「每天 9 点跑同一问」这类需求,又不需要引入 cron 解析依赖。
 * 时间按服务端本地时区解释(私有化部署通常是单一时区)。
 */

export type ReportFrequency = "daily" | "weekly";

export interface ReportSchedule {
  frequency: ReportFrequency;
  /** HH:MM(24 小时制,服务端本地时区)。 */
  time: string;
  /** weekly 必填:0=周日 .. 6=周六。 */
  weekday?: number;
}

export const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;

export interface TimeOfDay {
  hour: number;
  minute: number;
}

/** 解析 HH:MM;非法输入返回 null(调用方负责给用户可读的错误)。 */
export function parseTimeOfDay(value: string): TimeOfDay | null {
  const match = TIME_OF_DAY_PATTERN.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export type ScheduleParseResult =
  | { ok: true; value: ReportSchedule }
  | { ok: false; error: string };

/** 校验并归一化周期配置。weekly 必须带 weekday,daily 忽略 weekday。 */
export function parseReportSchedule(input: {
  frequency?: unknown;
  time?: unknown;
  weekday?: unknown;
}): ScheduleParseResult {
  const frequency = input.frequency;
  if (frequency !== "daily" && frequency !== "weekly") {
    return { ok: false, error: "frequency 必须为 daily 或 weekly" };
  }
  const time = typeof input.time === "string" ? input.time.trim() : "";
  if (!parseTimeOfDay(time)) {
    return { ok: false, error: "time 必须为 HH:MM(24 小时制)" };
  }
  if (frequency === "weekly") {
    const weekday = Number(input.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { ok: false, error: "weekly 周期必须提供 weekday(0=周日 .. 6=周六)" };
    }
    return { ok: true, value: { frequency, time, weekday } };
  }
  return { ok: true, value: { frequency, time } };
}

/**
 * 下一个执行时刻(严格晚于 from)。
 *
 * 默认按 UTC 计算,便于测试与多时区部署保持一致;生产如需本地时区,
 * 传入 `-new Date().getTimezoneOffset()` 即可。
 */
export function nextRunAt(
  schedule: ReportSchedule,
  from: number | Date = Date.now(),
  offsetMinutes = 0,
): number {
  const time = parseTimeOfDay(schedule.time);
  if (!time) throw new Error(`无效的报表时间点:${schedule.time}`);
  const fromMs = typeof from === "number" ? from : from.getTime();
  // 先把「墙上时间」平移到 UTC 坐标系,再按 UTC 做日期运算,避免依赖进程时区。
  const shifted = new Date(fromMs + offsetMinutes * MINUTE_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const todayAt = Date.UTC(year, month, day, time.hour, time.minute, 0, 0);
  let candidate: number;
  if (schedule.frequency === "weekly") {
    const weekday = schedule.weekday ?? 0;
    let deltaDays = (weekday - shifted.getUTCDay() + 7) % 7;
    if (deltaDays === 0 && todayAt <= shifted.getTime()) deltaDays = 7;
    candidate = Date.UTC(year, month, day + deltaDays, time.hour, time.minute, 0, 0);
  } else {
    candidate =
      todayAt > shifted.getTime()
        ? todayAt
        : Date.UTC(year, month, day + 1, time.hour, time.minute, 0, 0);
  }
  return candidate - offsetMinutes * MINUTE_MS;
}

/** 人类可读的周期描述,服务端与前端展示共用同一套措辞。 */
export function describeSchedule(schedule: ReportSchedule): string {
  const prefix = schedule.frequency === "weekly" ? `每${WEEKDAY_LABELS[schedule.weekday ?? 0]}` : "每天";
  return `${prefix} ${schedule.time}`;
}
