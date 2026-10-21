import { useMemo, useState } from "react";
import { Alert, Button, Card } from "antd";
import { CopyOutlined, DownOutlined, ReloadOutlined, UpOutlined } from "../lib/icons.js";
import type {
  Message,
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
import { UsageTag } from "./UsageTag.js";

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
          <div className="msg-meta">
            <UsageTag usage={message.usage} />
          </div>
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
          <UsageTag usage={message.usage} />
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

/** 片段数超过该阈值时整个引用区默认折叠，避免长列表把对话撑爆。 */
const CITATION_AUTO_OPEN_LIMIT = 5;
/** 引用区展开后首屏最多展示的行数，其余收进「展开其余」按钮。 */
const CITATION_VISIBLE_LIMIT = 8;

function RagCitations({ citations }: { citations?: RagCitation[] }) {
  const [sectionOpen, setSectionOpen] = useState(() => (citations?.length ?? 0) <= CITATION_AUTO_OPEN_LIMIT);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const groups = useMemo(() => {
    const ordered: { source: string; items: { citation: RagCitation; index: number }[] }[] = [];
    const bySource = new Map<string, { source: string; items: { citation: RagCitation; index: number }[] }>();
    for (const [index, citation] of (citations ?? []).entries()) {
      let group = bySource.get(citation.source);
      if (!group) {
        group = { source: citation.source, items: [] };
        bySource.set(citation.source, group);
        ordered.push(group);
      }
      group.items.push({ citation, index });
    }
    return ordered;
  }, [citations]);
  // 首屏只展示前 N 个（按后端相关度排序），避免 render 期计数，保证并发渲染安全。
  const visibleIndexes = useMemo(() => {
    const set = new Set<number>();
    const total = citations?.length ?? 0;
    const limit = showAll ? total : Math.min(total, CITATION_VISIBLE_LIMIT);
    for (let i = 0; i < limit; i += 1) set.add(i);
    return set;
  }, [citations, showAll]);
  if (!citations || citations.length === 0) return null;
  const sourceCount = groups.length;
  const hiddenCount = citations.length - visibleIndexes.size;
  const toggleSection = () => {
    setSectionOpen((open) => {
      if (open) {
        setExpanded(null);
        setShowAll(false);
      }
      return !open;
    });
  };
  return (
    <section className="rag-citations" aria-label="引用文档">
      <Button
        type="text"
        block
        className="rag-citations__header"
        aria-expanded={sectionOpen}
        onClick={toggleSection}
      >
        <span className="rag-citations__title">
          引用文档 · {citations.length} 个片段
          {sourceCount > 1 ? ` · ${sourceCount} 个来源` : ` · ${groups[0]?.source ?? ""}`}
        </span>
        {sectionOpen ? <UpOutlined /> : <DownOutlined />}
      </Button>
      {sectionOpen ? (
        <>
          {groups.map((group) =>
            group.items.some(({ index }) => visibleIndexes.has(index)) ? (
            <div className="rag-citations__group" key={group.source}>
              {sourceCount > 1 ? (
                <p className="rag-citations__group-title">
                  {group.source} · {group.items.length} 个片段
                </p>
              ) : null}
              <ul className="rag-citations__list">
              {group.items.map(({ citation, index }) => {
                if (!visibleIndexes.has(index)) return null;
                const isOpen = expanded === index;
                return (
                  <li
                    className="rag-citation"
                    key={`${citation.source}-${citation.chunkIndex}-${index}`}
                  >
                    <Button
                      type="text"
                      block
                      className="rag-citation__toggle"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : index)}
                      style={{ height: "auto", textAlign: "left" }}
                    >
                      <span className="rag-citation__index">
                        第 {Number(citation.chunkIndex) + 1} 段
                      </span>
                      <span className="rag-citation__snippet">{citation.content}</span>
                    </Button>
                    {isOpen ? <CitationViewer citation={citation} /> : null}
                  </li>
                );
              })}
              </ul>
            </div>
            ) : null,
          )}
          {hiddenCount > 0 || showAll ? (
            <Button
              type="link"
              size="small"
              className="rag-citations__more"
              onClick={() => setShowAll((all) => !all)}
            >
              {showAll ? "收起多余片段" : `展开其余 ${hiddenCount} 个片段`}
            </Button>
          ) : null}
        </>
      ) : null}
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
