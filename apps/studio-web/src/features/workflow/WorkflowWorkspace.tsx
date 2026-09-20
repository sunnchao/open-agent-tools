import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ApiOutlined,
  ApartmentOutlined,
  CloseOutlined,
  CopyOutlined,
  DeleteOutlined,
  PlusOutlined,
  SearchOutlined,
} from "../../lib/icons.js";
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  fetchWorkflows,
  type WorkflowAppRecord,
} from "./api.js";
import { loadSavedGraph } from "./graph.js";
import { WorkflowAccess } from "./WorkflowAccess.js";
import { WorkflowEditor } from "./WorkflowWorkspaceMain.js";

type WorkflowScreen = "library" | "editor" | "access";

export function WorkflowWorkspace() {
  const [screen, setScreen] = useState<WorkflowScreen>("library");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowAppRecord[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("新工作流");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setWorkflows(await fetchWorkflows());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "工作流列表加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return workflows;
    return workflows.filter((workflow) =>
      `${workflow.name} ${workflow.slug} ${workflow.description}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [query, workflows]);

  const open = (workflowId: string, next: Exclude<WorkflowScreen, "library">) => {
    setSelectedId(workflowId);
    setScreen(next);
  };

  const closeCreateDialog = () => {
    if (creating) return;
    setShowCreate(false);
    setCreateError(null);
  };

  const submitCreate = async () => {
    const name = createName.trim();
    if (!name) {
      setCreateError("请输入工作流名称");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const workflow = await createWorkflow({ name });
      setShowCreate(false);
      open(workflow.app.id, "editor");
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : "工作流创建失败");
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    if (!showCreate) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeCreateDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [creating, showCreate]);

  if (selectedId && screen === "editor") {
    return (
      <WorkflowEditor
        workflowId={selectedId}
        onBack={() => {
          setScreen("library");
          void refresh();
        }}
        onOpenAccess={() => setScreen("access")}
      />
    );
  }

  if (selectedId && screen === "access") {
    return (
      <WorkflowAccess
        workflowId={selectedId}
        onBack={() => setScreen("editor")}
        onChanged={() => void refresh()}
      />
    );
  }

  const localDraft = loadSavedGraph();

  return (
    <section className="workflow-library">
      <header className="workflow-library-header">
        <div>
          <span className="settings-kicker">WORKFLOW CONTROL PLANE</span>
          <h1>工作流</h1>
        </div>
        <button className="studio-button primary" type="button" onClick={() => setShowCreate(true)}>
          <PlusOutlined /> 新建工作流
        </button>
      </header>

      <div className="workflow-library-tools">
        <label>
          <SearchOutlined />
          <input
            value={query}
            placeholder="搜索名称或 slug"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span>{workflows.length} WORKFLOWS</span>
      </div>

      {error ? <div className="workflow-access-alert is-error">{error}</div> : null}
      {loading ? <div className="workflow-screen-state">正在加载工作流...</div> : null}
      {!loading && filtered.length === 0 ? (
        <div className="workflow-library-empty">
          <span>01</span>
          <h2>{query ? "没有匹配的工作流" : "创建第一个工作流"}</h2>
          {!query ? (
            <div>
              <button
                className="studio-button primary"
                type="button"
                onClick={() => setShowCreate(true)}
              >
                <PlusOutlined /> 从空白创建
              </button>
              {localDraft ? (
                <button
                  className="studio-button secondary"
                  type="button"
                  disabled={creating}
                  onClick={() => {
                    setCreating(true);
                    void createWorkflow({ name: localDraft.name, graph: localDraft })
                      .then((workflow) => open(workflow.app.id, "editor"))
                      .catch((reason) =>
                        setError(reason instanceof Error ? reason.message : "浏览器草稿导入失败"),
                      )
                      .finally(() => setCreating(false));
                  }}
                >
                  导入浏览器草稿
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {!loading && filtered.length > 0 ? (
        <div className="workflow-library-list">
          <div className="workflow-library-list-head">
            <span>工作流</span>
            <span>发布状态</span>
            <span>最近更新</span>
            <span aria-hidden="true" />
          </div>
          {filtered.map((workflow, index) => (
            <article key={workflow.id}>
              <button
                className="workflow-library-main"
                type="button"
                onClick={() => open(workflow.id, "editor")}
              >
                <span className="workflow-library-index">{String(index + 1).padStart(2, "0")}</span>
                <span>
                  <b>{workflow.name}</b>
                  <code>{workflow.slug}</code>
                </span>
              </button>
              <span
                className={`workflow-library-status${workflow.currentVersionId ? " is-live" : ""}`}
              >
                {workflow.currentVersionId ? "LIVE" : "DRAFT"}
              </span>
              <time dateTime={workflow.updatedAt}>
                {new Date(workflow.updatedAt).toLocaleString()}
              </time>
              <div className="workflow-library-actions">
                <button
                  type="button"
                  title="访问点"
                  aria-label="访问点"
                  onClick={() => open(workflow.id, "access")}
                >
                  <ApiOutlined />
                </button>
                <button
                  type="button"
                  title="复制工作流"
                  aria-label="复制工作流"
                  onClick={() => {
                    void duplicateWorkflow(workflow.id)
                      .then((created) => setWorkflows((current) => [created.app, ...current]))
                      .catch((reason) =>
                        setError(reason instanceof Error ? reason.message : "工作流复制失败"),
                      );
                  }}
                >
                  <CopyOutlined />
                </button>
                <button
                  type="button"
                  title="删除工作流"
                  aria-label="删除工作流"
                  onClick={() => {
                    if (!window.confirm(`删除“${workflow.name}”？已发布 API 将停止访问。`)) return;
                    void deleteWorkflow(workflow.id)
                      .then(() =>
                        setWorkflows((current) =>
                          current.filter((item) => item.id !== workflow.id),
                        ),
                      )
                      .catch((reason) =>
                        setError(reason instanceof Error ? reason.message : "工作流删除失败"),
                      );
                  }}
                >
                  <DeleteOutlined />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {showCreate
        ? createPortal(
            <div
              className="settings-modal-backdrop workflow-create-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.currentTarget === event.target) closeCreateDialog();
              }}
            >
              <form
                className="settings-modal workflow-create-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="workflow-create-title"
                aria-describedby={createError ? "workflow-create-error" : undefined}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitCreate();
                }}
              >
                <div className="settings-modal-head">
                  <div className="workflow-create-heading">
                    <span className="workflow-create-icon" aria-hidden="true">
                      <ApartmentOutlined />
                    </span>
                    <div>
                      <span className="settings-kicker">NEW WORKFLOW</span>
                      <h2 id="workflow-create-title">创建工作流</h2>
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label="关闭"
                    disabled={creating}
                    onClick={closeCreateDialog}
                  >
                    <CloseOutlined />
                  </button>
                </div>
                <div className="workflow-create-body">
                  <label className={`studio-field${createError ? " is-invalid" : ""}`}>
                    <span>
                      <b>工作流名称</b>
                      <small>{createName.trim().length}/120</small>
                    </span>
                    <input
                      autoFocus
                      maxLength={120}
                      placeholder="例如：客户工单自动分类"
                      value={createName}
                      aria-invalid={Boolean(createError)}
                      aria-describedby={createError ? "workflow-create-error" : undefined}
                      onChange={(event) => {
                        setCreateName(event.target.value);
                        if (createError) setCreateError(null);
                      }}
                    />
                    {createError ? (
                      <small className="field-error" id="workflow-create-error" role="alert">
                        {createError}
                      </small>
                    ) : null}
                  </label>
                </div>
                <div className="settings-modal-actions">
                  <button
                    className="studio-button secondary"
                    type="button"
                    disabled={creating}
                    onClick={closeCreateDialog}
                  >
                    取消
                  </button>
                  <button
                    className="studio-button primary"
                    type="submit"
                    disabled={creating || !createName.trim()}
                  >
                    {creating ? "创建中..." : "创建并编排"}
                  </button>
                </div>
              </form>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}
