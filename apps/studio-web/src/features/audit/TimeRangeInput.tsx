import { Flex, Input } from "antd";

/**
 * 审计时间范围输入。
 *
 * 服务端 IM 审计按毫秒时间戳过滤、问数审计按 ISO 字符串过滤，
 * 因此这里统一维护「本地日期时间」文本，由调用方自行转成各自口径。
 * 不用 antd DatePicker 是因为 dayjs 不是本包的直接依赖。
 */
export function TimeRangeInput({
  from,
  to,
  onChange,
  ariaLabel,
}: {
  from: string;
  to: string;
  onChange: (next: { from: string; to: string }) => void;
  ariaLabel: string;
}) {
  return (
    <Flex gap={8} align="center" wrap>
      <Input
        type="datetime-local"
        aria-label={`${ariaLabel}开始时间`}
        value={from}
        onChange={(event) => onChange({ from: event.target.value, to })}
        style={{ width: 190 }}
      />
      <span aria-hidden="true">→</span>
      <Input
        type="datetime-local"
        aria-label={`${ariaLabel}结束时间`}
        value={to}
        onChange={(event) => onChange({ from, to: event.target.value })}
        style={{ width: 190 }}
      />
    </Flex>
  );
}

/** 把 `datetime-local` 的本地时间文本转成毫秒时间戳。 */
export function localTimeToTimestamp(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
