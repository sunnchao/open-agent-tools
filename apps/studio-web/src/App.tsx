import { lazy, Suspense, useEffect, useState } from "react";
import {
  ApiOutlined,
  ApartmentOutlined,
  DatabaseOutlined,
  MessageOutlined,
  NodeIndexOutlined,
  SettingOutlined,
} from "./lib/icons.js";
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
const GraphWorkspace = lazy(() =>
  import("./features/graph/GraphWorkspace.js").then((module) => ({
    default: module.GraphWorkspaceWithProvider,
  })),
);
const WorkflowWorkspace = lazy(() =>
  import("./features/workflow/WorkflowWorkspace.js").then((module) => ({
    default: module.WorkflowWorkspace,
  })),
);
const SettingsWorkspace = lazy(() =>
  import("./features/settings/SettingsWorkspace.js").then((module) => ({
    default: module.SettingsWorkspace,
  })),
);

type Workspace = "chat" | "mcp" | "rag" | "graph" | "workflow" | "settings";

const workspaces: Array<{
  id: Workspace;
  label: string;
  en: string;
  icon: React.ReactNode;
}> = [
  { id: "chat", label: "对话", en: "Chat", icon: <MessageOutlined /> },
  { id: "mcp", label: "MCP", en: "Toolkit", icon: <ApiOutlined /> },
  { id: "rag", label: "知识库", en: "Knowledge", icon: <DatabaseOutlined /> },
  { id: "graph", label: "图谱", en: "Graph", icon: <NodeIndexOutlined /> },
  { id: "workflow", label: "工作流", en: "Workflow", icon: <ApartmentOutlined /> },
  { id: "settings", label: "设置", en: "Settings", icon: <SettingOutlined /> },
];

function workspaceFromHash(): Workspace {
  const value = window.location.hash.replace(/^#\/?/, "");
  return workspaces.some((item) => item.id === value) ? (value as Workspace) : "workflow";
}

/** 沉浸式品牌加载动画 */
function StudioLoading({ name = "" }: { name?: string }) {
  return (
    <div className="studio-loading" role="status" aria-live="polite">
      <div className="studio-loading__inner">
        <div className="studio-loading__wordmark">
          <span className="studio-loading__badge">OA</span>
          <p className="studio-loading__name">
            Open Agent Studio
            <em>{name || "Loading Workspace"}</em>
          </p>
        </div>
        <div className="studio-loading__line">
          <i />
        </div>
        <p className="studio-loading__hint">init · modules · rendering</p>
      </div>
    </div>
  );
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

  const active = workspaces.find((item) => item.id === workspace);

  return (
    <div className="studio-shell">
      <div className="studio-atmosphere" aria-hidden="true" />
      <nav className="studio-rail" aria-label="主工作区">
        <div className="studio-rail__top">
          <button
            type="button"
            className="studio-mark"
            aria-label="Open Agent Studio"
            onClick={() => navigate("workflow")}
          >
            <span className="studio-mark__glyph">OA</span>
            <span className="studio-mark__title">Open Agent Studio</span>
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
                <span className="studio-nav-item__icon">{item.icon}</span>
                <span className="studio-nav-item__label">{item.label}</span>
                <span className="studio-nav-item__tip">{item.en}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="studio-rail__foot">
          <div className="studio-environment" title="本地开发环境">
            <span />
            DEV
          </div>
        </div>
      </nav>

      <main className="studio-workspace">
        <div key={workspace} className="studio-workspace__panel">
          <Suspense fallback={<StudioLoading name={active?.en ?? "Workflow"} />}>
            {workspace === "chat" ? <ChatWorkspace /> : null}
            {workspace === "mcp" ? <McpWorkspace /> : null}
            {workspace === "rag" ? <RagWorkspace /> : null}
            {workspace === "graph" ? <GraphWorkspace /> : null}
            {workspace === "workflow" ? <WorkflowWorkspace /> : null}
            {workspace === "settings" ? <SettingsWorkspace /> : null}
          </Suspense>
        </div>
      </main>
    </div>
  );
}
