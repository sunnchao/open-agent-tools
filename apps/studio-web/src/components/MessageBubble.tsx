import { useState } from "react";
import { Alert, Button, Card } from "antd";
import { CopyOutlined, ReloadOutlined } from "../lib/icons.js";
import type {
  Message,
  MessageUsage,
  RagCitation,
  SqlResultProps,
  ToolCall,
  UiBlock,
} from "../types.js";
import { MarkdownView } from "./MarkdownView.js";
import { CitationViewer } from "./CitationViewer.js";
import { FinancialReportCard } from "./FinancialReportCard.js";
import { SqlResultCard } from "./SqlResultCard.js";
import { ToolCalls } from "./ToolCalls.js";

interface MessageBubbleProps {
  message: Message;
  onRetry?: () => void;
  onRegenerate?: () => void;
}

function formatTime(ts?: number) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function MessageActions({
  message,
  onRegenerate,
}: {
  message: Message;
  onRegenerate?: () => void;
}) {
  const handleCopy = () => {
    void navigator.clipboard?.writeText(message.content).catch(() => undefined);
  };
  return (
    <div className="msg-actions" onClick={(e) => e.stopPropagation()}>
      <Button type="text" size="small" icon={<CopyOutlined />} title="复制" onClick={handleCopy} />
      {onRegenerate ? (
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined />}
          title="重新生成"
          onClick={onRegenerate}
        />
      ) : null}
    </div>
  );
}

export function MessageBubble({ message, onRetry, onRegenerate }: MessageBubbleProps) {
  if (message.status === "error" && message.content.trim().length === 0) {
    return (
      <div className="msg-row msg-row--assistant">
        <div className="msg-avatar msg-avatar--assistant">AI</div>
        <div className="msg-body">
          <Alert
            type="error"
            showIcon
            title={message.errorMessage || "请求失败"}
            action={
              onRetry ? (
                <Button size="small" danger onClick={onRetry}>
                  重试
                </Button>
              ) : undefined
            }
            style={{ maxWidth: 640, width: "100%" }}
          />
        </div>
      </div>
    );
  }

  const isUser = message.role === "user";
  const isTool = message.role === "tool";

  if (isUser) {
    return (
      <div className="msg-row msg-row--user">
        <div className="msg-body">
          <div className="msg-bubble msg-bubble--user">
            <MarkdownView content={message.content} />
          </div>
          <div className="msg-meta">
            <span>{formatTime(message.createdAt)}</span>
          </div>
        </div>
        <div className="msg-avatar msg-avatar--user">我</div>
        <MessageActions message={message} />
      </div>
    );
  }

  if (isTool) {
    return <LegacyToolBubble message={message} />;
  }

  // assistant
  const hasContent = message.content.trim().length > 0;
  const hasToolCalls = (message.toolCalls?.length ?? 0) > 0;
  const hasUi = (message.uiBlocks?.length ?? 0) > 0;
  const hasCitations = (message.ragCitations?.length ?? 0) > 0;
  const isThinking = message.status === "streaming" && !hasContent && !hasToolCalls && !hasUi;
  const isStopped = message.status === "stopped";
  const isError = message.status === "error";

  // 空消息不渲染（思考中、已停止、出错除外，否则用户看不到终态）
  if (
    !hasContent &&
    !hasToolCalls &&
    !hasUi &&
    !hasCitations &&
    !isThinking &&
    !isStopped &&
    !isError
  ) {
    return <></>;
  }

  const canRegenerate =
    (message.status === "complete" || message.status === "stopped") && Boolean(onRegenerate);

  return (
    <div className="msg-row msg-row--assistant">
      <div className="msg-avatar msg-avatar--assistant">AI</div>
      <div className="msg-body">
        <div className="msg-bubble msg-bubble--assistant">
          {isThinking ? (
            <div className="thinking-indicator">
              <span className="thinking-dot" />
              <span className="thinking-dot" />
              <span className="thinking-dot" />
            </div>
          ) : (
            <>
              {hasContent ? <MarkdownView content={message.content} /> : null}
              <RagCitations citations={message.ragCitations} />
              <UiBlocks blocks={message.uiBlocks} />
              <ToolCalls toolCalls={message.toolCalls} />
              {message.status === "streaming" && <span className="msg__caret" />}
              {isError ? (
                <Alert
                  type="error"
                  showIcon
                  title={message.errorMessage || "请求失败"}
                  action={
                    onRetry ? (
                      <Button size="small" danger onClick={onRetry}>
                        重试
                      </Button>
                    ) : undefined
                  }
                  style={{ marginTop: 8 }}
                />
              ) : null}
            </>
          )}
        </div>
        <div className="msg-meta">
          <span>{formatTime(message.createdAt)}</span>
          {isStopped ? <span>已停止生成</span> : null}
          <MessageUsageTag usage={message.usage} />
          {canRegenerate ? (
            <Button
              type="link"
              size="small"
              style={{ height: 16, padding: 0, fontSize: 11 }}
              icon={<ReloadOutlined />}
              onClick={onRegenerate}
            >
              重新生成
            </Button>
          ) : null}
        </div>
      </div>
      <MessageActions message={message} />
    </div>
  );
}

/** token 与工具用量标签：与 `/api/admin/usage` 同口径，便于成本对账。 */
function MessageUsageTag({ usage }: { usage?: MessageUsage }) {
  if (!usage || usage.totalTokens <= 0) return null;
  const parts = [`${formatTokens(usage.totalTokens)} tokens`];
  if (usage.toolCalls > 0) {
    parts.push(
      usage.toolErrors > 0
        ? `工具 ${usage.toolCalls} 次（${usage.toolErrors} 失败）`
        : `工具 ${usage.toolCalls} 次`,
    );
  }
  return (
    <span title={`输入 ${usage.inputTokens} · 输出 ${usage.outputTokens}`}>
      {parts.join(" · ")}
    </span>
  );
}

function formatTokens(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function RagCitations({ citations }: { citations?: RagCitation[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  if (!citations || citations.length === 0) return null;
  return (
    <section className="rag-citations" aria-label="引用文档">
      <p className="rag-citations__title">引用文档 · {citations.length} 个片段</p>
      <ul className="rag-citations__list">
        {citations.map((citation, index) => {
          const isOpen = expanded === index;
          return (
            <li className="rag-citation" key={`${citation.source}-${citation.chunkIndex}-${index}`}>
              <button
                type="button"
                className="rag-citation__toggle"
                aria-expanded={isOpen}
                onClick={() => setExpanded(isOpen ? null : index)}
              >
                <span className="rag-citation__source">{citation.source}</span>
                <span className="rag-citation__index">第 {Number(citation.chunkIndex) + 1} 段</span>
                <span className="rag-citation__snippet">{citation.content}</span>
              </button>
              {isOpen ? <CitationViewer citation={citation} /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function UiBlocks({ blocks }: { blocks?: UiBlock[] }) {
  if (!blocks || blocks.length === 0) return null;
  return (
    <div className="ui-blocks">
      {blocks.map((block, index) => {
        if (block.type === "sql_result") {
          return <SqlResultCard key={index} {...(block.props as SqlResultProps)} />;
        }
        if (block.type !== "financial_report_card") return null;
        const reports = (block as Extract<UiBlock, { type: "financial_report_card" }>).props
          .reports;
        return <FinancialReportCard key={index} reports={reports} />;
      })}
    </div>
  );
}

const LegacyToolBubble = ({ message }: MessageBubbleProps) => {
  let data: unknown = null;
  try {
    data = JSON.parse(message.content || "null");
  } catch {
    data = null;
  }

  if (
    data &&
    typeof data === "object" &&
    "ui" in data &&
    (data as { ui?: { type?: string; props?: { reports?: unknown } } }).ui?.type ===
      "financial_report_card"
  ) {
    const ui = (data as { ui: { props: { reports: never[] } } }).ui;
    return (
      <div className="msg-row msg-row--tool">
        <div className="msg-avatar msg-avatar--assistant">AI</div>
        <div className="msg-body">
          <div className="msg-bubble msg-bubble--assistant">
            <FinancialReportCard reports={ui.props.reports} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="msg-row msg-row--tool">
      <div className="msg-avatar msg-avatar--assistant">AI</div>
      <div className="msg-body">
        <Card size="small" style={{ maxWidth: 720, width: "100%" }}>
          <pre className="tool-legacy">{message.content}</pre>
        </Card>
      </div>
    </div>
  );
};

export type { ToolCall };
