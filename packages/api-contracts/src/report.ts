export type ReportFrequency = "daily" | "weekly";

export interface ReportSchedule {
  frequency: ReportFrequency;
  /** HH:MM(24 小时制)。 */
  time: string;
  /** weekly 必填:0=周日 .. 6=周六。 */
  weekday?: number;
}

export const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** 人类可读的报表周期描述，服务端调度与客户端展示共用。 */
export function describeSchedule(schedule: ReportSchedule): string {
  const prefix =
    schedule.frequency === "weekly" ? `每${WEEKDAY_LABELS[schedule.weekday ?? 0]}` : "每天";
  return `${prefix} ${schedule.time}`;
}
