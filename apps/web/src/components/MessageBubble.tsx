import { Alert, Button, Card } from "antd";
import type { Message, ToolCall } from "../types.js";
import { MarkdownView } from "./MarkdownView.js";
import { FinancialReportCard } from "./FinancialReportCard.js";
import { ToolCalls } from "./ToolCalls.js";

interface MessageBubbleProps {
  message: Message;
  onRetry?: () => void;
}

export function MessageBubble({ message, onRetry }: MessageBubbleProps) {
  if (message.status === "error") {
    return (
      <div className="msg-row msg-row--assistant">
        <Alert
          type="error"
          showIcon
          message={message.content || "Request failed"}
          action={
            onRetry ? (
              <Button size="small" danger onClick={onRetry}>
                Retry
              </Button>
            ) : undefined
          }
          style={{ maxWidth: 640, width: "100%" }}
        />
      </div>
    );
  }

  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const isTool = message.role === "tool";

  if (isUser) {
    return (
      <div className="msg-row msg-row--user">
        <div className="msg-bubble msg-bubble--user">
          <MarkdownView content={message.content} />
        </div>
      </div>
    );
  }

  if (isAssistant) {
    const hasContent = message.content.trim().length > 0;
    const hasToolCalls = (message.toolCalls?.length ?? 0) > 0;
    const hasUi = (message.uiBlocks?.length ?? 0) > 0;
    if (!hasContent && !hasToolCalls && !hasUi) return <></>;
    return (
      <div className="msg-row msg-row--assistant">
        <div className="msg-bubble msg-bubble--assistant">
          {hasContent ? <MarkdownView content={message.content} /> : null}
          <UiBlocks blocks={message.uiBlocks} />
          <ToolCalls toolCalls={message.toolCalls} />
          {message.status === "streaming" && <span className="msg__caret" />}
        </div>
      </div>
    );
  }

  if (isTool) {
    return <LegacyToolBubble message={message} />;
  }

  return (
    <div className="msg-row msg-row--assistant">
      <div className="msg-bubble msg-bubble--assistant">
        <MarkdownView content={message.content} />
      </div>
    </div>
  );
}

function UiBlocks({ blocks }: { blocks?: import("../types.js").UiBlock[] }) {
  if (!blocks || blocks.length === 0) return null;
  return (
    <div className="ui-blocks">
      {blocks.map((block, index) => {
        if (block.type !== "financial_report_card") return null;
        const reports = (
          block as Extract<import("../types.js").UiBlock, { type: "financial_report_card" }>
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
        <div className="msg-bubble msg-bubble--assistant">
          <FinancialReportCard reports={ui.props.reports} />
        </div>
      </div>
    );
  }

  return (
    <div className="msg-row msg-row--tool">
      <Card size="small" style={{ maxWidth: 720, width: "100%" }}>
        <pre className="tool-legacy">{message.content}</pre>
      </Card>
    </div>
  );
};

export type { ToolCall };
