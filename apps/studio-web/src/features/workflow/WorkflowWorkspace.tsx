import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Input,
  Modal,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiOutlined,
  CopyOutlined,
  DeleteOutlined,
  PlusOutlined,
} from "../../lib/icons.js";
import {
  createWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  fetchWorkflows,
  fetchWorkflow,
  type WorkflowAppRecord,
} from "./api.js";
import { loadSavedGraph } from "./graph.js";
import { WorkflowAccess } from "./WorkflowAccess.js";
import { WorkflowEditor } from "./WorkflowWorkspaceMain.js";
import { useResourceCatalog } from "../resources/useResourceCatalog.js";
import { downloadWorkflow, parseWorkflowFile, workflowFileSizeLimit } from "./io.js";
import { validateWorkflowGraph } from "./model.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { confirmAction } from "../../components/studio/confirmAction.js";
import type { WorkflowSnapshot } from "./types.js";

type WorkflowScreen = "library" | "editor" | "access";

interface WorkflowWorkspaceProps {
  /** 路由里的工作流 ID（`#/workflow/<workflowId>`）。 */
  workflowId: string | null;
  /** 子页面标记：`access` 表示访问点页（`#/workflow/<workflowId>/access`）。 */
  subScreen: string | null;
  /** 打开 / 返回某个工作流时回写路由，地址栏立即带上对应 ID。 */
  onRouteChange: (segments: string[]) => void;
}

export function WorkflowWorkspace({
  workflowId,
  subScreen,
  onRouteChange,
}: WorkflowWorkspaceProps) {
  const { message } = App.useApp();
  const [workflows, setWorkflows] = useState<WorkflowAppRecord[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("新工作流");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const resources = useResourceCatalog();
  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [pendingExport, setPendingExport] = useState<{
    graph: WorkflowSnapshot;
    slug: string;
  } | null>(null);

  // 当前界面由路由推导：带 ID 即进入详情页，第二段 `access` 表示访问点页。
  const selectedId = workflowId;
  const screen: WorkflowScreen = workflowId
    ? subScreen === "access"
      ? "access"
      : "editor"
    : "library";

  const importFile = async (file: File) => {
    setImporting(true);
    setError(null);
    try {
      if (file.size > workflowFileSizeLimit) throw new Error("工作流文件超过 2 MB");
      const graph = parseWorkflowFile(await file.text(), resources.catalog);
      const created = await createWorkflow({ name: `${graph.name} 导入`.slice(0, 200), graph });
      open(created.app.id, "editor");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导入失败");
    } finally {
      setImporting(false);
    }
  };
  const exportFile = async (workflow: WorkflowAppRecord) => {
    try {
      const { workflow: detail } = await fetchWorkflow(workflow.id);
      if (validateWorkflowGraph(detail.draft.nodes, detail.draft.edges, resources.catalog).length) {
        setPendingExport({ graph: detail.draft, slug: workflow.slug });
      } else downloadWorkflow(detail.draft, workflow.slug);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导出失败");
    }
  };

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

  /** 打开某个工作流详情页 / 访问点页：把 ID 写进路由。 */
  const open = (id: string, next: Exclude<WorkflowScreen, "library">) => {
    onRouteChange(next === "access" ? [id, "access"] : [id]);
  };

  /** 返回工作流列表：清掉路由里的工作流 ID。 */
  const backToLibrary = () => {
    onRouteChange([]);
    void refresh();
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



  if (selectedId && screen === "editor") {
    return (
      <WorkflowEditor
        workflowId={selectedId}
        onBack={backToLibrary}
        onOpenAccess={() => open(selectedId, "access")}
      />
    );
  }

  if (selectedId && screen === "access") {
    return (
      <WorkflowAccess
        workflowId={selectedId}
        onBack={() => open(selectedId, "editor")}
        onChanged={() => void refresh()}
      />
    );
  }

  const localDraft = loadSavedGraph();

  const doDelete = (workflow: WorkflowAppRecord) => {
    confirmAction({
      title: `删除“${workflow.name}”？`,
      content: "已发布 API 将停止访问，该操作不可恢复。",
      okText: "确认删除",
      onOk: async () => {
        try {
          await deleteWorkflow(workflow.id);
          setWorkflows((current) => current.filter((item) => item.id !== workflow.id));
          message.success("工作流已删除");
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "工作流删除失败");
        }
      },
    });
  };

  const doDuplicate = async (workflow: WorkflowAppRecord) => {
    try {
      const created = await duplicateWorkflow(workflow.id);
      setWorkflows((current) => [created.app, ...current]);
      message.success("工作流已复制");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "工作流复制失败");
    }
  };

  return (
    <Flex vertical gap={12} style={{ height: "100%", overflow: "auto", padding: 16 }}>
      <Card size="small">
        <Flex align="center" justify="space-between" gap={12} wrap>
          <Flex vertical gap={2}>
            <Typography.Text type="secondary" style={{ fontSize: 10, letterSpacing: 2 }}>
              WORKFLOW CONTROL PLANE
            </Typography.Text>
            <Typography.Title level={4} style={{ margin: 0 }}>
              工作流
            </Typography.Title>
          </Flex>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowCreate(true)}>
            新建工作流
          </Button>
        </Flex>
      </Card>

      <Card size="small">
        <Flex gap={12} align="center" wrap>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importFile(file);
            }}
          />
          <Button disabled={importing || resources.loading} onClick={() => fileInput.current?.click()}>
            {importing ? "导入中…" : "导入 JSON"}
          </Button>
          <Input.Search
            allowClear
            value={query}
            placeholder="搜索名称或 slug"
            onChange={(event) => setQuery(event.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <Tag>{workflows.length} WORKFLOWS</Tag>
        </Flex>
      </Card>

      {error ? <Alert type="error" showIcon message={error} role="alert" /> : null}
      {pendingExport ? (
        <ConfirmDialog
          title="导出存在问题的工作流？"
          detail="当前草稿存在校验问题，修复后才可运行或重新导入。"
          confirmLabel="仍然导出"
          onCancel={() => setPendingExport(null)}
          onConfirm={() => {
            try {
              downloadWorkflow(pendingExport.graph, pendingExport.slug);
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : "导出失败");
            }
            setPendingExport(null);
          }}
        />
      ) : null}
      {loading ? (
        <Flex justify="center" style={{ padding: 48 }}>
          <Spin tip="正在加载工作流..." />
        </Flex>
      ) : null}
      {!loading && filtered.length === 0 ? (
        <Card size="small">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={query ? "没有匹配的工作流" : "创建第一个工作流"}
          >
            {!query ? (
              <Flex gap={8} justify="center">
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowCreate(true)}>
                  从空白创建
                </Button>
                {localDraft ? (
                  <Button
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
                  </Button>
                ) : null}
              </Flex>
            ) : null}
          </Empty>
        </Card>
      ) : null}

      {!loading && filtered.length > 0 ? (
        <Card
          size="small"
          title="工作流列表"
          extra={<Tag>{filtered.length}</Tag>}
          styles={{ body: { padding: 0 } }}
        >
          <Table<WorkflowAppRecord>
            size="small"
            rowKey="id"
            dataSource={filtered}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            onRow={(workflow) => ({
              onClick: () => open(workflow.id, "editor"),
              style: { cursor: "pointer" },
            })}
            columns={[
              {
                title: "工作流",
                key: "name",
                render: (_: unknown, workflow: WorkflowAppRecord) => (
                  <Flex vertical gap={0}>
                    <Typography.Text strong>{workflow.name}</Typography.Text>
                    <Typography.Text type="secondary" code style={{ fontSize: 12 }}>
                      {workflow.slug}
                    </Typography.Text>
                  </Flex>
                ),
              },
              {
                title: "发布状态",
                key: "status",
                width: 110,
                render: (_: unknown, workflow: WorkflowAppRecord) =>
                  workflow.currentVersionId ? (
                    <Tag color="success">LIVE</Tag>
                  ) : (
                    <Tag>DRAFT</Tag>
                  ),
              },
              {
                title: "最近更新",
                dataIndex: "updatedAt",
                key: "updatedAt",
                width: 190,
                render: (value: string) => new Date(value).toLocaleString(),
              },
              {
                title: "操作",
                key: "actions",
                width: 190,
                fixed: "right",
                render: (_: unknown, workflow: WorkflowAppRecord) => (
                  <Flex
                    gap={4}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Tooltip title="导出 JSON">
                      <Button type="text" size="small" onClick={() => void exportFile(workflow)}>
                        JSON
                      </Button>
                    </Tooltip>
                    <Tooltip title="访问点">
                      <Button
                        type="text"
                        size="small"
                        icon={<ApiOutlined />}
                        aria-label="访问点"
                        onClick={() => open(workflow.id, "access")}
                      />
                    </Tooltip>
                    <Tooltip title="复制工作流">
                      <Button
                        type="text"
                        size="small"
                        icon={<CopyOutlined />}
                        aria-label="复制工作流"
                        onClick={() => void doDuplicate(workflow)}
                      />
                    </Tooltip>
                    <Tooltip title="删除工作流">
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        aria-label="删除工作流"
                        onClick={() => doDelete(workflow)}
                      />
                    </Tooltip>
                  </Flex>
                ),
              },
            ]}
          />
        </Card>
      ) : null}

      <Modal
        open={showCreate}
        centered
        title="创建工作流"
        okText={creating ? "创建中..." : "创建并编排"}
        cancelText="取消"
        confirmLoading={creating}
        onCancel={closeCreateDialog}
        onOk={() => void submitCreate()}
      >
        <Typography.Paragraph type="secondary">NEW WORKFLOW</Typography.Paragraph>
        <Form layout="vertical" preserve={false}>
          <Form.Item
            label={`工作流名称 · ${createName.trim().length}/120`}
            validateStatus={createError ? "error" : undefined}
            help={createError}
          >
            <Input
              autoFocus
              maxLength={120}
              placeholder="例如：客户工单自动分类"
              value={createName}
              aria-invalid={Boolean(createError)}
              onChange={(event) => {
                setCreateName(event.target.value);
                if (createError) setCreateError(null);
              }}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Flex>
  );
}
