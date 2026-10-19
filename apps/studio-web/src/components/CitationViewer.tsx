import { useEffect, useMemo, useState } from "react";
import { Button } from "antd";
import { AuditOutlined, LoadingOutlined } from "../lib/icons.js";
import { listChunks, type ChunkInfo } from "../features/rag/api.js";
import { requestOpenChunk } from "../features/rag/chunkTarget.js";
import type { RagCitation } from "../types.js";

export interface HighlightSegment {
  text: string;
  highlight: boolean;
}

/** 归一化空白:忽略换行与多余空格,让引用片段与分块原文的匹配更稳。 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 把引用文本编译成「空白可伸缩」的正则,用于在分块原文里定位片段。 */
function highlightPattern(citation: string): RegExp | null {
  const needle = normalizeWhitespace(citation);
  if (!needle) return null;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(escaped);
}

/**
 * 保守高亮:归一化空白后做子串匹配,只在整段命中时才切出高亮区间。
 * 匹配不到就整段不高亮 —— 宁可不高亮,也不要错误标红误导用户。
 */
export function matchHighlight(text: string, citation: string): HighlightSegment[] {
  const pattern = highlightPattern(citation);
  if (!pattern) return [{ text, highlight: false }];
  const match = pattern.exec(text);
  if (!match || match[0].length === 0) return [{ text, highlight: false }];
  const start = match.index;
  const end = start + match[0].length;
  const segments: HighlightSegment[] = [];
  if (start > 0) segments.push({ text: text.slice(0, start), highlight: false });
  segments.push({ text: text.slice(start, end), highlight: true });
  if (end < text.length) segments.push({ text: text.slice(end), highlight: false });
  return segments;
}

/** 按 chunkIndex 在分块列表中定位;找不到返回 null,由调用方给出降级提示。 */
export function locateChunk(chunks: ChunkInfo[], chunkIndex: number): ChunkInfo | null {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  return chunks.find((chunk) => chunk.chunkIndex === chunkIndex) ?? null;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; chunks: ChunkInfo[] }
  | { status: "error"; message: string };

interface CitationViewerProps {
  citation: RagCitation;
}

/**
 * A4 引用定位:展开引用后,到知识库里取回该文档的分块,定位引用所在分块并高亮引用片段。
 * 文档被重新上传导致分块编号失效时,降级展示引用原文并明确告知,不静默出错。
 */
export function CitationViewer({ citation }: CitationViewerProps) {
  const chunkIndex = Number(citation.chunkIndex);
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    listChunks(citation.source)
      .then((response) => {
        if (!cancelled) setState({ status: "ready", chunks: response.chunks });
      })
      .catch((reason) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: reason instanceof Error ? reason.message : String(reason),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [citation.source]);

  const chunk = state.status === "ready" ? locateChunk(state.chunks, chunkIndex) : null;
  const total = state.status === "ready" ? state.chunks.length : null;
  const segments = useMemo(
    () => (chunk ? matchHighlight(chunk.content, citation.content) : []),
    [chunk, citation.content],
  );
  const highlighted = segments.some((segment) => segment.highlight);

  const open = () => {
    requestOpenChunk({ source: citation.source, chunkIndex });
  };

  return (
    <div className="citation-viewer">
      <div className="citation-viewer__head">
        <span className="citation-viewer__doc">
          <AuditOutlined />
          {citation.source}
        </span>
        <span className="citation-viewer__loc">
          第 {chunkIndex + 1} 段{total != null ? ` / 共 ${total} 段` : ""}
        </span>
      </div>

      {state.status === "loading" ? (
        <p className="citation-viewer__state">
          <LoadingOutlined spin />
          正在定位分块...
        </p>
      ) : null}

      {state.status === "error" ? (
        <p className="citation-viewer__state citation-viewer__state--warn">
          读取知识库失败,以下为引用原文:{state.message}
        </p>
      ) : null}

      {state.status === "ready" && !chunk ? (
        <p className="citation-viewer__state citation-viewer__state--warn">
          该文档已更新,引用分块 #{chunkIndex + 1} 已不存在,以下为引用原文。
        </p>
      ) : null}

      {chunk ? (
        <>
          <p className="citation-viewer__content">
            {segments.map((segment, index) =>
              segment.highlight ? (
                <mark key={index} className="citation-viewer__mark">
                  {segment.text}
                </mark>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )}
          </p>
          {!highlighted ? (
            <p className="citation-viewer__hint">未能精确定位引用片段,以上为所在分块原文。</p>
          ) : null}
        </>
      ) : state.status === "ready" || state.status === "error" ? (
        <p className="citation-viewer__content">{citation.content}</p>
      ) : null}

      <div className="citation-viewer__actions">
        <Button type="default" size="small" onClick={open}>
          在知识库中打开
        </Button>
      </div>
    </div>
  );
}
