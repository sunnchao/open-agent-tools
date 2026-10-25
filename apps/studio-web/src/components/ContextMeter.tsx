import { Tooltip } from "antd";
import { formatKiloTokens, type ChatCompactReport } from "@open-agent-tools/studio-client";

interface ContextMeterProps {
  /** 最新上下文快照；null 表示后端未上报（降级显示）。 */
  compact: ChatCompactReport | null;
  onOpen: () => void;
}

export type ContextMeterLevel = "idle" | "normal" | "warn" | "over";

export function describeCompact(compact: ChatCompactReport): {
  ratio: number;
  level: Exclude<ContextMeterLevel, "idle">;
  text: string;
} {
  const ratio = compact.inputCap > 0 ? compact.estimatedTokens / compact.inputCap : 0;
  const level = compact.droppedMessages > 0 || ratio >= 0.95 ? "over" : ratio >= 0.7 ? "warn" : "normal";
  const text =
    `约 ${formatKiloTokens(compact.estimatedTokens)} / ${formatKiloTokens(compact.inputCap)}` +
    (compact.droppedMessages > 0 ? ` · 已裁剪 ${compact.droppedMessages} 条` : "");
  return { ratio, level, text };
}

function breakdownTitle(compact: ChatCompactReport): string {
  const { history, rag, tools, system } = compact.breakdown;
  const lines = [
    "本轮实际送往模型的上下文构成（估算）：",
    `历史消息 ${formatKiloTokens(history)}`,
    `知识库引用 ${formatKiloTokens(rag)}${compact.ragTruncated ? "（已截断）" : ""}`,
    `工具定义 ${formatKiloTokens(tools)}`,
    `系统提示 ${formatKiloTokens(system)}`,
    "估算口径：英文约 4 字符、中文约 1.5 字符；仅供展示，不用于计费。",
  ];
  return lines.join("\n");
}

/**
 * 会话级上下文 meter：常驻表头，点击打开上下文面板（M3）。
 * 无快照时降级为灰色占位，不报错、不抖动。
 */
export function ContextMeter({ compact, onOpen }: ContextMeterProps) {
  if (!compact) {
    return (
      <Tooltip title="后端未上报上下文用量，升级服务端后可用">
        <span className="ctx-meter ctx-meter--idle" aria-label="上下文用量不可用">
          上下文 —
        </span>
      </Tooltip>
    );
  }
  const { ratio, level, text } = describeCompact(compact);
  return (
    <Tooltip title={breakdownTitle(compact)}>
      <button
        type="button"
        className={`ctx-meter ctx-meter--${level}`}
        onClick={onOpen}
        aria-label={`上下文用量：${text}。点击打开上下文设置`}
      >
        <span className="ctx-meter__text" aria-live="polite">
          {text}
        </span>
        <span className="ctx-meter__bar" aria-hidden="true">
          <span
            className="ctx-meter__fill"
            style={{ width: `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%` }}
          />
        </span>
      </button>
    </Tooltip>
  );
}
