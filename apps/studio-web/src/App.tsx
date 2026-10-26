import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Input, Modal, Popover } from "antd";
import { DEFAULT_BRANDING, type BrandingConfig } from "./features/branding/api.js";
import { ragRouteState } from "./features/rag/ragRoute.js";
import { buildHashRoute, parseHashRoute, sameRoute, type StudioRoute } from "./lib/routing.js";
import {
  ApiOutlined,
  ApartmentOutlined,
  AuditOutlined,
  BarChartOutlined,
  BellOutlined,
  BrainOutlined,
  BranchesOutlined,
  CommandOutlined,
  DatabaseOutlined,
  MenuOutlined,
  MessageOutlined,
  RightOutlined,
  SearchOutlined,
  SettingOutlined,
  TableOutlined,
} from "./lib/icons.js";
import "./styles/studio.css";

const ChatWorkspace = lazy(() =>
  import("./features/chat/ChatWorkspace.js").then((module) => ({
    default: module.ChatWorkspace,
  })),
);
const MemoryWorkspace = lazy(() =>
  import("./features/memory/MemoryWorkspace.js").then((module) => ({
    default: module.MemoryWorkspace,
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
const SettingsWorkspace = lazy(() =>
  import("./features/settings/SettingsWorkspace.js").then((module) => ({
    default: module.SettingsWorkspace,
  })),
);
const ObservatoryWorkspace = lazy(() =>
  import("./features/observatory/ObservatoryWorkspace.js").then((module) => ({
    default: module.ObservatoryWorkspaceWithProvider,
  })),
);
const ConnectorsWorkspace = lazy(() =>
  import("./features/connectors/ConnectorsWorkspace.js").then((module) => ({
    default: module.ConnectorsWorkspace,
  })),
);
const AuditWorkspace = lazy(() =>
  import("./features/audit/AuditWorkspace.js").then((module) => ({
    default: module.AuditWorkspace,
  })),
);
const ReportsWorkspace = lazy(() =>
  import("./features/reports/ReportsWorkspace.js").then((module) => ({
    default: module.ReportsWorkspace,
  })),
);

type Workspace =
  | "chat"
  | "memory"
  | "mcp"
  | "rag"
  | "connectors"
  | "observatory"
  | "audit"
  | "reports"
  | "workflow"
  | "settings";

const workspaces: Array<{
  id: Workspace;
  label: string;
  en: string;
  badge: string;
  icon: React.ReactNode;
}> = [
  { id: "chat", label: "对话", en: "Chat", badge: "AI", icon: <MessageOutlined /> },
  { id: "memory", label: "记忆", en: "Memory", badge: "MEM", icon: <BrainOutlined /> },
  { id: "mcp", label: "MCP", en: "Toolkit", badge: "API", icon: <ApiOutlined /> },
  { id: "rag", label: "知识库", en: "Knowledge", badge: "RAG+KG", icon: <DatabaseOutlined /> },
  {
    id: "connectors",
    label: "连接器",
    en: "Connectors",
    badge: "SYNC",
    icon: <BranchesOutlined />,
  },
  { id: "observatory", label: "问数", en: "Schema", badge: "SQL", icon: <TableOutlined /> },
  { id: "audit", label: "审计", en: "Audit", badge: "LOG", icon: <AuditOutlined /> },
  { id: "reports", label: "报表", en: "Reports", badge: "CRON", icon: <BarChartOutlined /> },
  {
    id: "workflow",
    label: "工作流",
    en: "Workflow",
    badge: "FLOW",
    icon: <ApartmentOutlined />,
  },
  { id: "settings", label: "设置", en: "Settings", badge: "", icon: <SettingOutlined /> },
];

function routeFromHash(): StudioRoute {
  return parseHashRoute(window.location.hash);
}

/**
 * 旧 `#/graph` 工作区已被知识库吸收；
 * 这里只把它归一到 rag，具体的「图谱视图 + 文档」由 RagWorkspace 通过路由参数解析。
 * 其余未知 workspace 仍回落 workflow。
 */
function workspaceFromRoute(route: StudioRoute): Workspace {
  if (route.workspace === "graph") return "rag";
  return workspaces.some((item) => item.id === route.workspace)
    ? (route.workspace as Workspace)
    : "workflow";
}

/** 沉浸式品牌加载动画 */
function StudioLoading({
  name = "",
  branding = DEFAULT_BRANDING,
}: {
  name?: string;
  branding?: BrandingConfig;
}) {
  return (
    <div className="studio-loading" role="status" aria-live="polite">
      <div className="studio-loading__inner">
        <div className="studio-loading__wordmark">
          <span className="studio-loading__badge">{branding.markText}</span>
          <p className="studio-loading__name">
            {branding.productName}
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

/** `branding` 由 main.tsx 在启动时读取并注入,App 自身不再重复请求。 */
export function App({ branding = DEFAULT_BRANDING }: { branding?: BrandingConfig }) {
  const [route, setRoute] = useState<StudioRoute>(routeFromHash);
  const [railOpen, setRailOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const workspace = workspaceFromRoute(route);
  // 知识库合并了原来的图谱工作区：视图与文档选择都从路由派生（#/graph 兼容 #/rag/graph）。
  const ragRoute = ragRouteState(route);

  useEffect(() => {
    const handleHashChange = () =>
      setRoute((prev) => {
        const next = routeFromHash();
        return sameRoute(prev, next) ? prev : next;
      });
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  /**
   * 写入 hash 路由。地址栏变化与 React 状态同步完成，
   * 点击会话 / 工作流时地址栏立刻带上对应 ID，刷新也能回到同一处。
   */
  const navigateTo = useCallback((target: Workspace, segments: string[] = []) => {
    window.location.hash = buildHashRoute(target, segments);
    setRoute({ workspace: target, segments });
  }, []);

  const handleChatSessionChange = useCallback(
    (sessionId: string) => navigateTo("chat", [sessionId]),
    [navigateTo],
  );

  const handleWorkflowRouteChange = useCallback(
    (segments: string[]) => navigateTo("workflow", segments),
    [navigateTo],
  );

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const navigate = (next: Workspace) => {
    // 已在该工作区时保留当前实体路由（例如 #/chat/<sessionId>）。
    if (next !== workspace) navigateTo(next);
    setRailOpen(false);
    setSearchOpen(false);
    setSearchQuery("");
  };

  const active = workspaces.find((item) => item.id === workspace);
  const primaryWorkspaces = workspaces.filter((item) => item.id !== "settings");
  const settingsWorkspace = workspaces.find((item) => item.id === "settings")!;
  const filteredWorkspaces = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return workspaces;
    return workspaces.filter((item) => `${item.label} ${item.en}`.toLowerCase().includes(query));
  }, [searchQuery]);
  const productFoot = branding.footerText || "企业内部 AI 工具平台";
  const operator = {
    name: "平台管理员",
    role: "工作台管理员",
    initials: "管",
  };

  const notificationPanel = (
    <div className="studio-popover-panel">
      <div className="studio-popover-panel__head">
        <strong>通知</strong>
        <span>全部已读</span>
      </div>
      <div className="studio-popover-empty">
        <BellOutlined />
        <strong>暂无新通知</strong>
        <span>服务运行、构建与审批消息会出现在这里。</span>
      </div>
    </div>
  );

  const accountPanel = (
    <div className="studio-popover-panel studio-account-panel">
      <div className="studio-account-panel__identity">
        <span className="studio-avatar studio-avatar--large">{operator.initials}</span>
        <span>
          <strong>{operator.name}</strong>
          <small>{operator.role}</small>
        </span>
      </div>
      <div className="studio-account-panel__meta">
        <span>当前产品</span>
        <strong>{branding.productName}</strong>
      </div>
      <div className="studio-account-panel__meta">
        <span>运行环境</span>
        <strong>DEV · 本地开发</strong>
      </div>
      <button
        type="button"
        className="studio-account-panel__link"
        onClick={() => navigate("settings")}
      >
        进入工作台设置
        <RightOutlined />
      </button>
    </div>
  );

  return (
    <div className={`studio-shell studio-shell--${workspace}`}>
      <button
        type="button"
        className={`studio-rail-scrim${railOpen ? " is-open" : ""}`}
        aria-label="关闭导航"
        onClick={() => setRailOpen(false)}
      />

      <aside
        id="studio-rail"
        className={`studio-rail${railOpen ? " is-open" : ""}`}
        aria-label="主导航"
      >
        <button
          type="button"
          className="studio-brand"
          aria-label={`${branding.productName} Studio`}
          onClick={() => navigate("workflow")}
        >
          <span className="studio-brand__mark">
            {branding.logoUrl ? (
              <img src={branding.logoUrl} alt="" width={24} height={24} />
            ) : (
              branding.markText
            )}
          </span>
          <span className="studio-brand__copy">
            <strong>{branding.productName}</strong>
            <span>STUDIO</span>
          </span>
        </button>

        <div className="studio-rail__section">工作区</div>
        <nav className="studio-nav" aria-label="工作区导航">
          {primaryWorkspaces.map((item) => (
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
              <span className="studio-nav-item__meta">{item.badge}</span>
            </button>
          ))}
          <div className="studio-nav__divider" />
          <button
            type="button"
            className={`studio-nav-item${workspace === "settings" ? " is-active" : ""}`}
            aria-current={workspace === "settings" ? "page" : undefined}
            aria-label={settingsWorkspace.label}
            title={settingsWorkspace.label}
            onClick={() => navigate("settings")}
          >
            <span className="studio-nav-item__icon">{settingsWorkspace.icon}</span>
            <span className="studio-nav-item__label">{settingsWorkspace.label}</span>
            <span className="studio-nav-item__meta" />
          </button>
        </nav>

        <div className="studio-rail__foot">
          <p className="studio-rail__footer-text" title={productFoot}>
            {productFoot}
          </p>
          <div className="studio-rail__env">
            <span className="studio-rail__env-dot" />
            本地开发环境 <b>DEV</b>
          </div>
          <button
            type="button"
            className="studio-rail__user"
            onClick={() => navigate("settings")}
            aria-label={`${operator.name} · ${operator.role}`}
          >
            <span className="studio-avatar">{operator.initials}</span>
            <span className="studio-rail__user-copy">
              <strong>{operator.name}</strong>
              <small>{operator.role}</small>
            </span>
            <RightOutlined className="studio-rail__user-chevron" />
          </button>
          {branding.partnerCode ? (
            <span className="studio-rail__partner" title="渠道归属">
              <span>#</span>
              {branding.partnerCode}
            </span>
          ) : null}
        </div>
      </aside>

      <div className="studio-main">
        <header className="studio-topbar">
          <button
            type="button"
            className="studio-topbar__menu"
            onClick={() => setRailOpen(true)}
            aria-label="打开导航"
            aria-expanded={railOpen}
            aria-controls="studio-rail"
          >
            <MenuOutlined />
          </button>
          <div className="studio-crumb" aria-label="当前位置">
            <span>工作台</span>
            <b>/</b>
            <strong>{active?.label ?? "工作台"}</strong>
          </div>
          <div className="studio-topbar__right">
            <button
              type="button"
              className="studio-search-trigger"
              onClick={() => setSearchOpen(true)}
              aria-label="搜索或跳转"
              aria-keyshortcuts="Meta+K Control+K"
            >
              <SearchOutlined />
              <span>搜索或跳转</span>
              <kbd>⌘K</kbd>
            </button>
            <span className="studio-env-pill">
              <span />
              DEV
            </span>
            <Popover
              trigger="click"
              placement="bottomRight"
              content={notificationPanel}
              arrow={false}
              overlayClassName="studio-popover"
            >
              <button type="button" className="studio-icon-button" aria-label="通知">
                <BellOutlined />
                <span className="studio-notification-dot" />
              </button>
            </Popover>
            <Popover
              trigger="click"
              placement="bottomRight"
              content={accountPanel}
              arrow={false}
              overlayClassName="studio-popover"
            >
              <button
                type="button"
                className="studio-avatar studio-avatar--button"
                aria-label={`账户菜单 · ${operator.initials} · ${operator.name}`}
              >
                {operator.initials}
              </button>
            </Popover>
          </div>
        </header>

        <main
          id="workspace"
          className={`studio-workspace studio-workspace--${workspace}`}
          tabIndex={-1}
        >
          <div key={workspace} className="studio-workspace__panel">
            <Suspense
              fallback={<StudioLoading name={active?.en ?? "Workflow"} branding={branding} />}
            >
              {workspace === "chat" ? (
                <ChatWorkspace
                  sessionId={route.segments[0] ?? null}
                  onSessionChange={handleChatSessionChange}
                />
              ) : null}
              {workspace === "memory" ? (
                <MemoryWorkspace
                  factId={route.segments[1] ?? null}
                  onOpenFact={(id) =>
                    navigateTo("memory", id ? ["fact", id] : [])
                  }
                />
              ) : null}
              {workspace === "mcp" ? <McpWorkspace /> : null}
              {workspace === "rag" ? (
                <RagWorkspace
                  initialView={ragRoute.initialView}
                  initialSource={ragRoute.initialSource}
                />
              ) : null}
              {workspace === "connectors" ? <ConnectorsWorkspace /> : null}
              {workspace === "observatory" ? <ObservatoryWorkspace /> : null}
              {workspace === "audit" ? <AuditWorkspace /> : null}
              {workspace === "reports" ? <ReportsWorkspace /> : null}
              {workspace === "workflow" ? (
                <WorkflowWorkspace
                  workflowId={route.segments[0] ?? null}
                  subScreen={route.segments[1] ?? null}
                  onRouteChange={handleWorkflowRouteChange}
                />
              ) : null}
              {workspace === "settings" ? <SettingsWorkspace /> : null}
            </Suspense>
          </div>
        </main>
      </div>

      <Modal
        open={searchOpen}
        footer={null}
        closable={false}
        width={560}
        centered
        destroyOnHidden
        rootClassName="studio-command-modal"
        onCancel={() => {
          setSearchOpen(false);
          setSearchQuery("");
        }}
      >
        <div className="studio-command">
          <div className="studio-command__search">
            <SearchOutlined />
            <Input
              autoFocus
              variant="borderless"
              placeholder="搜索工作区或功能"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onPressEnter={() => {
                const first = filteredWorkspaces[0];
                if (first) navigate(first.id);
              }}
            />
            <kbd>ESC</kbd>
          </div>
          <div className="studio-command__label">工作区</div>
          <div className="studio-command__results">
            {filteredWorkspaces.length > 0 ? (
              filteredWorkspaces.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={workspace === item.id ? "is-active" : ""}
                  onClick={() => navigate(item.id)}
                >
                  <span className="studio-command__icon">{item.icon}</span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.en}</small>
                  </span>
                  {workspace === item.id ? <em>当前</em> : <RightOutlined />}
                </button>
              ))
            ) : (
              <div className="studio-command__empty">没有匹配的工作区</div>
            )}
          </div>
          <div className="studio-command__footer">
            <span>
              <CommandOutlined /> K
            </span>
            <span>Enter 打开 · Esc 关闭</span>
          </div>
        </div>
      </Modal>
    </div>
  );
}
