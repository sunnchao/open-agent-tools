import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "antd";
import { CheckOutlined, CopyOutlined } from "../lib/icons.js";
import type { Components } from "react-markdown";

interface MarkdownViewProps {
  content: string;
}

function CodeBlock({ children, className }: { children: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const lang = className?.replace("language-", "") ?? "text";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be blocked — ignore
    }
  };

  return (
    <pre>
      <span className="code-lang">{lang}</span>
      <Button
        className="code-copy"
        size="small"
        type="text"
        icon={copied ? <CheckOutlined /> : <CopyOutlined />}
        onClick={handleCopy}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
      <code>{children}</code>
    </pre>
  );
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children);
    if (!className) {
      return <code>{children}</code>;
    }
    return <CodeBlock className={className}>{text}</CodeBlock>;
  },
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
};

export const MarkdownView = memo(function MarkdownView({ content }: MarkdownViewProps) {
  if (!content) return null;
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
