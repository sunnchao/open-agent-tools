import { Alert, Button, Card } from "antd";
import { CopyOutlined, ReloadOutlined } from "@ant-design/icons";
import type { Message, RagCitation, ToolCall, UiBlock } from "../types.js";
import { MarkdownView } from "./MarkdownView.js";
import { FinancialReportCard } from "./FinancialReportCard.js";
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

function MessageActions({ message, onRegenerate }: { message: Message; onRegenerate?: () => void }) {
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
  if (message.status === "error") {
    return (
      <div className="msg-row msg-row--assistant">
        <div className="msg-avatar msg-avatar--assistant">AI</div>
        <div className="msg-body">
          <Alert
            type="error"
            showIcon
            message={message.content || "请求失败"}
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
  if (!hasContent && !hasToolCalls && !hasUi && !hasCitations) return <></>;

  const canRegenerate = message.status === "complete" && Boolean(onRegenerate);

  return (
    <div className="msg-row msg-row--assistant">
      <div className="msg-avatar msg-avatar--assistant">AI</div>
      <div className="msg-body">
        <div className="msg-bubble msg-bubble--assistant">
          {hasContent ? <MarkdownView content={message.content} /> : null}
          <RagCitations citations={message.ragCitations} />
          <UiBlocks blocks={message.uiBlocks} />
          <ToolCalls toolCalls={message.toolCalls} />
          {message.status === "streaming" && <span className="msg__caret" />}
        </div>
        <div className="msg-meta">
          <span>{formatTime(message.createdAt)}</span>
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
      <MessageActions message={message} onRegenerate={canRegenerate ? onRegenerate : undefined} />
    </div>
  );
}

function RagCitations({ citations }: { citations?: RagCitation[] }) {
  if (!citations || citations.length === 0) return null;
  return (
    <details className="rag-citations">
      <summary>引用文档 · {citations.length} 个片段</summary>
      <div>
        {citations.map((citation, index) => (
          <article key={`${citation.source}-${citation.chunkIndex}-${index}`}>
            <b>{citation.source}</b>
            <span>第 {Number(citation.chunkIndex) + 1} 段</span>
            <p>{citation.content}</p>
          </article>
        ))}
      </div>
    </details>
  );
}

function UiBlocks({ blocks }: { blocks?: UiBlock[] }) {
  if (!blocks || blocks.length === 0) return null;
  return (
    <div className="ui-blocks">
      {blocks.map((block, index) => {
        if (block.type !== "financial_report_card") return null;
        const reports = (
          block as Extract<UiBlock, { type: "financial_report_card" }>
        ).props.reports;
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
