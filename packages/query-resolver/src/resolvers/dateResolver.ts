import type { Period, ResolverResult } from "../types.js";

const TZ = "Asia/Shanghai";

/** 取得北京时间（Asia/Shanghai）的当前时刻，避免服务器时区导致"今天"算错 */
export function shanghaiNow(): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "00";
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const hh = get("hour");
  const mm = get("minute");
  const ss = get("second");
  return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}+08:00`);
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function monthEnd(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function periodFromMonth(base: Date, tz: string): Period {
  return { start: fmtDate(monthStart(base)), end: fmtDate(monthEnd(base)), tz };
}

export function lastMonthPeriod(now: Date = shanghaiNow(), tz = TZ): Period {
  return periodFromMonth(addMonths(now, -1), tz);
}
export function thisMonthPeriod(now: Date = shanghaiNow(), tz = TZ): Period {
  return periodFromMonth(now, tz);
}

/**
 * 把相对/绝对时间表达解析成 [start, end]。
 * - raw 未提供：默认上月（场景约定）
 * - raw 提供但解析不出：missing=true，交由编排器反问，绝不静默用默认
 */
export function resolveDate(
  raw: string | undefined,
  now: Date = shanghaiNow(),
  tz = TZ,
): ResolverResult<Period> {
  if (!raw) {
    const p = lastMonthPeriod(now, tz);
    return { value: p, candidates: [], ambiguous: false, missing: false, note: "未提供时间，默认上月" };
  }

  // 绝对：YYYY年MM月 或 YYYY-MM
  const ym = raw.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/) ?? raw.match(/(\d{4})-(\d{1,2})/);
  if (ym) {
    const y = Number(ym[1]);
    const m = Number(ym[2]);
    if (m >= 1 && m <= 12) {
      return {
        value: periodFromMonth(new Date(y, m - 1, 1), tz),
        candidates: [],
        ambiguous: false,
        missing: false,
        note: `解析为 ${y}年${m}月`,
      };
    }
  }

  if (/本\s*季度|这个季度|这季度/.test(raw)) {
    const q = Math.floor(now.getMonth() / 3);
    const start = periodFromMonth(new Date(now.getFullYear(), q * 3, 1), tz);
    const end = fmtDate(new Date(now.getFullYear(), q * 3 + 3, 0));
    return { value: { ...start, end }, candidates: [], ambiguous: false, missing: false, note: "本季度" };
  }

  if (/上\s*季度/.test(raw)) {
    const q = Math.floor(now.getMonth() / 3) - 1;
    const y = q < 0 ? now.getFullYear() - 1 : now.getFullYear();
    const qq = (q + 4) % 4;
    const start = periodFromMonth(new Date(y, qq * 3, 1), tz);
    const end = fmtDate(new Date(y, qq * 3 + 3, 0));
    return { value: { ...start, end }, candidates: [], ambiguous: false, missing: false, note: "上季度" };
  }

  const recent = raw.match(/最近\s*(\d+)\s*天/);
  if (recent) {
    const n = Number(recent[1]);
    const end = now;
    const start = new Date(now);
    start.setDate(start.getDate() - (n - 1));
    return {
      value: { start: fmtDate(start), end: fmtDate(end), tz },
      candidates: [],
      ambiguous: false,
      missing: false,
      note: `最近${n}天`,
    };
  }

  if (/去\s*年/.test(raw)) {
    const y = now.getFullYear() - 1;
    return { value: { start: `${y}-01-01`, end: `${y}-12-31`, tz }, candidates: [], ambiguous: false, missing: false, note: "去年" };
  }
  if (/前\s*年/.test(raw)) {
    const y = now.getFullYear() - 2;
    return { value: { start: `${y}-01-01`, end: `${y}-12-31`, tz }, candidates: [], ambiguous: false, missing: false, note: "前年" };
  }

  if (/本\s*月|这个月|这月/.test(raw)) {
    return { value: thisMonthPeriod(now, tz), candidates: [], ambiguous: false, missing: false, note: "本月" };
  }

  // 上月 / 上上月 ……：数"上"的个数
  if (/上{1,2}个?月/.test(raw)) {
    const n = (raw.match(/上/g) ?? []).length;
    return { value: periodFromMonth(addMonths(now, -n), tz), candidates: [], ambiguous: false, missing: false, note: `前${n}个月` };
  }

  // 用户提供时间但解析不出 → 标记缺失，交由编排器反问
  return { value: null, candidates: [], ambiguous: false, missing: true, note: `无法解析时间表达式: ${raw}` };
}
