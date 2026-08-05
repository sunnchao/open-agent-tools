import { lazy, Suspense, useEffect, useState } from "react";
import {
  ApiOutlined,
  ApartmentOutlined,
  DatabaseOutlined,
  MessageOutlined,
} from "@ant-design/icons";
import "./styles/studio.css";

const ChatWorkspace = lazy(() =>
  import("./features/chat/ChatWorkspace.js").then((module) => ({
    default: module.ChatWorkspace,
  })),
);
const McpWorkspace = lazy(() =>
  import("./features/mcp/McpWorkspace.js").then((module) => ({
    default: module.McpWorkspace,
  })),
);
const RagWorkspace = lazy(() =>
  import("./features/rag/RagWorkspace.js").then((module) => ({
    default: module.RagWorkspace,
  })),
);
const WorkflowWorkspace = lazy(() =>
  import("./features/workflow/WorkflowWorkspace.js").then((module) => ({
    default: module.WorkflowWorkspace,
  })),
);

type Workspace = "chat" | "mcp" | "rag" | "workflow";

const workspaces: Array<{
  id: Workspace;
  label: string;
  icon: React.ReactNode;
}> = [
  { id: "chat", label: "对话", icon: <MessageOutlined /> },
  { id: "mcp", label: "MCP", icon: <ApiOutlined /> },
  { id: "rag", label: "知识库", icon: <DatabaseOutlined /> },
  { id: "workflow", label: "工作流", icon: <ApartmentOutlined /> },
];

function workspaceFromHash(): Workspace {
  const value = window.location.hash.replace(/^#\/?/, "");
  return workspaces.some((item) => item.id === value) ? (value as Workspace) : "workflow";
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace>(workspaceFromHash);

  useEffect(() => {
    const handleHashChange = () => setWorkspace(workspaceFromHash());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const navigate = (next: Workspace) => {
    window.location.hash = next;
    setWorkspace(next);
  };

  return (
    <div className="studio-shell">
      <nav className="studio-rail" aria-label="主工作区">
        <button
          type="button"
          className="studio-mark"
          aria-label="Open Agent Studio"
          onClick={() => navigate("workflow")}
        >
          OA
        </button>
        <div className="studio-nav-items">
          {workspaces.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`studio-nav-item${workspace === item.id ? " is-active" : ""}`}
              aria-current={workspace === item.id ? "page" : undefined}
              aria-label={item.label}
              title={item.label}
              onClick={() => navigate(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        <div className="studio-environment" title="本地开发环境">
          <span />
          DEV
        </div>
      </nav>

      <main className="studio-workspace">
        <Suspense fallback={<div className="workspace-loading">正在加载工作区...</div>}>
          {workspace === "chat" ? <ChatWorkspace /> : null}
          {workspace === "mcp" ? <McpWorkspace /> : null}
          {workspace === "rag" ? <RagWorkspace /> : null}
          {workspace === "workflow" ? <WorkflowWorkspace /> : null}
        </Suspense>
      </main>
    </div>
  );
}
