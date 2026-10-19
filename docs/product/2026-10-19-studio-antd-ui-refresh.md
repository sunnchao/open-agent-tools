# Studio Web Ant Design 统一 UI 刷新方案

> 日期:2026-10-19 · 范围:`apps/studio-web` 全站 9 个工作区 + 员工端入口 · 形态:**方案文档,先立规范再动手**
> 关联:`apps/studio-web/src/main.tsx`(ConfigProvider 主题)、`apps/studio-web/src/styles/studio.css`(11915 行)、`apps/studio-web/src/lib/icons.tsx`(Lucide 桥接层)
> 决策:**全站统一到 Ant Design 6.x 组件库,不引入新 UI 库；`studio.css` 只做收敛不做重写,先并存后删除。**

## 0. 结论先行

1. **模板已定,不用再找**:管理类页面抄 `features/workflow/WorkflowWorkspaceMain.tsx` + `features/workflow/NodeInspector.tsx` 的 antd 写法(`Flex` + `Form` + `Segmented` + `Alert` + `Empty` + `Typography`);会话/抽屉类页面抄 `features/chat/ChatWorkspace.tsx` + `features/chat/ChatResourceDrawer.tsx` 的 `Layout` + `Sider` + `Drawer` 骨架。
2. **主题入口唯一**:只改 `main.tsx` 的 `ConfigProvider.theme`,各页禁止散写色值；品牌色(`branding.primaryColor` / `accentColor`)继续驱动 `colorPrimary` / `colorInfo`,`applyBranding` 写的 `--studio-brand-*` 变量保留。
3. **图标不动**:继续用 `lib/icons.tsx` 的 Lucide 桥接(`*Outlined` 命名兼容 antd 调用),antd 组件的 `icon` 属性直接传桥接图标。
4. **迁移顺序**(由小到大、由散到整):`settings → connectors → reports → rag → mcp → graph → observatory → workflow(图书馆页) → chat(只做 token 对齐)`;`EmployeeApp` 单独收尾,不与 Studio 共组件。
5. **旧样式先兜底后删除**:`studio-button` / `domain-*` / `resource-panel` 等旧 class 在迁移完成前保留,整页切完后再删对应 CSS,而不是边改边删。

## 1. 目标与非目标

### 1.1 目标

- 全站视觉语言统一到 antd:按钮、表单、表格、空态、加载、反馈、确认框只有一种写法。
- 每个工作区共享同一套页面骨架:页头(标题 + 描述 + 操作区,可选 Tabs) + 内容区(列表/详情/检查器) + 统一的空态与错误态。
- 主题可品牌化:换 `BrandingConfig` 即换全站主色,不需要改业务代码。
- 迁移过程可验证:每页迁移后 `pnpm --filter @open-agent-tools/studio-web typecheck && pnpm --filter @open-agent-tools/studio-web lint && pnpm --filter @open-agent-tools/studio-web build` 通过,且保留原有交互行为。

### 1.2 非目标

- 不重做信息架构:9 个工作区划分、路由(hash)与导航(`App.tsx` 的 `studio-rail`)本次不动。
- 不替换画布引擎:`workflow` 编辑器与 `graph` / `observatory` 的 `@xyflow/react` 画布不动,只统一其周围的工具条、面板与表单。
- 不引入新组件库(Tailwind / shadcn / MUI 等)；不升级 React / antd 大版本。
- 员工端(`EmployeeApp`)不与管理端共用复杂组件,只对齐 token 与基础控件。

## 2. 现状审计(2026-10-19 实测)

| 维度 | 现状 | 证据 |
|---|---|---|
| antd 基座 | `antd ^6.5.2`,`ConfigProvider` + `AntApp` 包全站,浅色主题 token 已按品牌定制 | `src/main.tsx:3,52-101` |
| 图标 | Lucide 经 `lib/icons.tsx` 桥接,命名兼容 `@ant-design/icons`,全站可直接用 | `src/lib/icons.tsx:100-160` |
| antd 标杆 | 工作流编辑器 antd 化最完整(`Badge/Button/Empty/Flex/Input/Segmented/Typography`);`NodeInspector` 是 `Form + Collapse + Alert + Segmented` 范本 | `workflow/WorkflowWorkspaceMain.tsx:11`,`workflow/NodeInspector.tsx:1-20` |
| 聊天骨架 | `Layout + Sider + Button + Typography` 标准 antd 骨架;`Drawer + Checkbox + Slider + Empty` 有现成例子 | `components/Sidebar.tsx`,`features/chat/ChatResourceDrawer.tsx:1-14` |
| 落后页面 | `mcp/rag/connectors/graph/observatory/reports/settings` 仍手写 `domain-workspace` + `studio-button` + 原生 table/form | `studio-button` 在 30+ 文件残留,见 §2.1 |
| 确认框 | 至少 16 处 `window.confirm`,三套确认范式并存 | `rg window.confirm` 见 §2.1 |
| 原生控件 | `McpWorkspace` 40 处、`SettingsWorkspace` 34 处、`McpOperations` 35 处原生 `table/form/input/button` | `rg <table\|<form\|<input\|<button` 见 §2.1 |
| CSS 体量 | `studio.css` 11915 行 + `workflow-panels.css` 654 行 + `observatory.css` 501 行 + `reports.css` 230 行,合计约 13300 行；顶层选择器以 `.markdown(33)` / `.workflow-node(29)` / `.studio-field(21)` / `.studio-button(12)` 为主 | `wc -l`,选择器统计 |

### 2.1 关键计数(审计命令留档)

```bash
# 自定义按钮残留(按文件计数,节选)
rg -c "studio-button" apps/studio-web/src --glob '*.tsx' | sort
# McpWorkspace:15, McpOperations:13, SettingsWorkspace:10,
# WorkflowWorkspaceMain:8, QueryAuditView:8, ObservatoryWorkspace:8 ...

# 原生确认框
rg -c "window.confirm" apps/studio-web/src --glob '*.tsx' | sort
# McpWorkspace:6, McpOperations:2, 其余 8 个文件各 1 处

# 原生表格/表单/输入/按钮(管理页)
rg -c "<table|<form|<input|<button" apps/studio-web/src/features/mcp \
  apps/studio-web/src/features/rag apps/studio-web/src/features/connectors \
  apps/studio-web/src/features/graph apps/studio-web/src/features/observatory \
  apps/studio-web/src/features/reports apps/studio-web/src/features/settings --glob '*.tsx' | sort
```

## 3. UI 规范(执行期唯一依据)

### 3.1 页面骨架:两种模板,不得自创第三种

**模板 A — 管理页(列表 + 详情 + 检查器)**,适用于 `settings / connectors / reports / rag / mcp / graph / observatory`:

```tsx
import { Flex, Layout, Typography } from "antd";
import { StudioPageHeader } from "../../components/studio/StudioPageHeader.js";

<StudioPage layout="manage" eyebrow="..." title="..." description="...">
  {/* 操作区统一走 header actions,禁止页内另起工具条 */}
  {/* 内容区:Flex 三栏或两栏,左右栏用 Card 包,禁止裸 div 面板 */}
</StudioPage>
```

- 页头必须包含:英文 eyebrow(`Typography.Text type="secondary"`,大写小字) + 中文 `Typography.Title level={4}`(禁止手写 `h1` 样式) + 可选 `description`(`Typography.Paragraph type="secondary"`) + 右侧 `actions`(`Flex gap={8}`)。
- 多视图切换统一用 `Segmented`(`NodeInspector` 写法),顶部 tab 较多的 `mcp` 可用 `Tabs` 收敛到同一视觉,禁止手写 `mcp-management-tabs` / `obs-view-tabs`。
- 状态徽标统一用 `Badge` / `Tag`,禁止手写 `status-dot` / `capability-state`。
- 通知统一用 `Alert(showIcon, closable)` 顶栏展示,禁止手写 `workspace-notice` / `settings-alert` / `connection-state`。

**模板 B — 会话页(侧栏 + 主区 + 抽屉)**,适用于 `chat` 与资源抽屉:

```tsx
import { Drawer, Layout } from "antd";
// 抄 ChatWorkspace: Layout > Sider(会话) + Layout(Header/Content/Composer) + Drawer(资源)
```

- 会话侧栏用 `Layout.Sider(theme="light")`,折叠走 `collapsed/collapsedWidth={0}`,移动端遮罩保留 `chat-session-backdrop` 行为但样式收进 antd token。
- 资源配置用 `Drawer(title, extra=刷新按钮)`,内部分组用 `Collapse` 或带标题的 `Card`,勾选行用 `Checkbox` + `Empty` 空态(抄 `ChatResourceDrawer`)。

### 3.2 组件映射表(旧 → 新,强制)

| 旧写法 | 新写法 | 备注 |
|---|---|---|
| `button.studio-button.primary/secondary/compact` | `Button type="primary" / "default" / "text", size="small"` | 图标经 `lib/icons.tsx`,危险操作 `danger` |
| `button.icon-command` | `Button type="text" icon={...}` | 仅放图标,加 `aria-label` + `Tooltip` |
| `div.workspace-notice / settings-alert / connection-state` | `Alert type="success/error/warning/info" showIcon` | 错误带重试按钮放 `action` |
| `div.panel-heading + span.count-badge` | `Card title={...} extra={<Tag>{n}</Tag>}` 或 `Flex + Typography.Text + Tag` | 标题用 `Typography.Text strong`,计数用 `Tag` |
| `div.panel-state / workflow-screen-state / rag-analytics-state` | `Empty(description) + Spin(loading)` | 加载与空态分离,禁止混写 |
| `label.studio-field + input/select/textarea` | `Form layout="vertical" + Form.Item(label, help, validateStatus) + Input/Select/InputNumber/Switch` | 抄 `NodeInspector` / `SqlQueryNodeEditor` |
| `table.provider-table / connectors-runs__table` | `Table(size="small", pagination={pageSize})` | 超过 20 行必须分页,禁止 `limit=100` 硬截断无分页 |
| `window.confirm` | `Modal.confirm` 或 `Popconfirm`(行内删除用后者,抄 `SessionList`) | 文案含后果与不可逆说明 |
| `div.settings-modal / studio-dialog` | `Modal` / `Drawer` | 表单弹窗用 `Modal + Form`,复杂配置用 `Drawer` |
| `div.segmented-control / mcp-management-tabs / obs-view-tabs` | `Segmented` / `Tabs` | 视图切换优先 `Segmented`,超过 4 个用 `Tabs` |
| `span.status-dot / capability-state` | `Badge status="success/processing/error"` + `Tag` | 状态文字保留,颜色走 token |
| 原生 `input[type=file]` 拖拽区 | `Upload.Dragger` | `rag` 文档上传首个试点 |
| 手写 `pagination` 缺失的长列表 | `Table.pagination` 或 `List.pagination` | 本次把无分页当缺陷修 |

### 3.3 主题:唯一入口 `main.tsx`

- 全局 token(已存在,保持):`colorPrimary=branding.primaryColor`、`colorInfo=branding.accentColor`、`colorSuccess #2f9e6e`、`colorWarning #d98a2b`、`colorError #d64545`、`colorTextBase #1d2024`、`colorBgBase #f6f5f1`、`colorBgContainer #ffffff`、`colorBgLayout #f0efea`、`borderRadius 8`、`fontSize 14`。
- 本次新增(补齐到 `ConfigProvider.components`):`Card`(`borderRadiusLG 10`、`paddingLG 16`)、`Table`(`headerBg #faf9f6`)、`Tabs`(`inkBarColor=colorPrimary`)、`Segmented`、`Alert`、`Modal`、`Empty`、`Tag`，全部引用 token,禁止硬编码十六进制。
- 页面级强调色(如 `mcp` 绿 `#0e9f82` / `rag` 橙 `#d9822b`)降级为 `Tag.color` 或小面积点缀,不再整页染色；`primary` 按钮颜色全局跟随品牌色。
- 深色模式本次不做；`studio-grain` / `studio-atmosphere` 装饰层保留,不进入 antd token。

### 3.4 布局与密度

- 管理页内容区统一 `Flex gap={12}`,左右栏 `Card`，列表栏宽 260~300,详情自适应,检查器 320~360；低于 1100px 时检查器收进 `Drawer`(抄 `ChatWorkspace` 的 `compactLayout` 逻辑)。
- 表格统一 `size="small"`,表单统一 `layout="vertical"`,按钮组统一 `Flex gap={8} justify="flex-end"` 右下对齐。
- 文字层级只用三档:`Title level 4`(页标题)、`Text strong`(卡片标题/行标题)、`Text type="secondary"`(描述/时间戳)；禁止页内自定义字号色值。
- 反馈规则:操作成功用 `App.useApp().message.success`,失败用 `Alert` 或 `message.error` 二选一,同一页面不得混用四套通知。
- 确认规则:不可逆操作(删除、禁用服务、发布、回滚)必须 `Modal.confirm/Popconfirm`,文案格式:`标题 + 后果 + [确认删除]`。

### 3.5 无障碍与响应式

- 图标按钮必有 `aria-label`；`Sider` 折叠按钮关联 `aria-controls`；表单错误用 `Form.Item validateStatus + help` 而不是裸 `small.field-error`。
- 触达目标不小于 32px(`Button controlHeight 32` 已定)；移动端(<768px)表格允许横向滚动,禁止挤压换行。
- 动效只用 antd 自带(`Spin`, `Skeleton`, `Drawer` 过渡),`prefers-reduced-motion` 已在 `global.css` 处理,不得新增自定义 keyframes。

## 4. 模板选型结论(为什么是这两份)

- `WorkflowWorkspaceMain.tsx` 是全站唯一同时用对 `Flex 布局 + Segmented 切换 + Empty 空态 + Typography 层级` 的文件,且已有移动端三视图(`palette/canvas/inspector`)收敛逻辑,可直接复制到管理页。
- `NodeInspector.tsx` 是全站唯一把 `Form + Input + Collapse + Alert + Segmented` 组合写对的检查器,字段错误、资源缺失、变量修复三种态齐全,表单页照抄它不会走样。
- `ChatWorkspace.tsx + Sidebar.tsx + ChatResourceDrawer.tsx` 是唯一走通 `Layout + Sider + Drawer` 的会话骨架,且 `SessionList` 已示范 `Input(search) + Popconfirm(删除) + Space(行操作)`，会话类页面照抄即可。
- 反例:`RagWorkspace` 功能全但手写 class 最多(原生控件 22 处),适合当“被改造对象”而不适合当模板；`SettingsWorkspace` 两栏骨架可留,但 `settings-*` 私有 class 与 `provider-table` 必须换掉。

## 5. 分页迁移清单(执行打勾用)

| # | 页面 | 现状骨架 | 改法 | 验收要点 |
|---|---|---|---|---|
| P1 | `settings/SettingsWorkspace.tsx` + `McpGatewaySection` + `SchemaSourcesSection` + `im/ImChannelsWorkspace` | `settings-workspace` + `settings-sections` + `provider-table` + 原生 input(34+27+6 处) | 左侧改 `Menu` 或 `Segmented` 导航,右侧内容 `Card + Form + Table`;`provider-table` → `Table` 分页；`settings-alert` → `Alert` | Provider 增删改、Schema 源测试连接、IM 保存三条链路可用 |
| P2 | `connectors/ConnectorsWorkspace.tsx` | `domain-*` + `connectors-*` 私有 class + 原生 form/table(12 处) | 首个完整试点:页头 `StudioPageHeader`,列表 `List/Card`,表单 `Form`,同步记录 `Table`,删除 `Popconfirm` | 新建/编辑/同步/删除全链路 |
| P3 | `reports/ReportsWorkspace.tsx` + `reports.css` | `domain-grid` + `reports-*` + 原生 form(12 处) | 表单 `Form + Select + TimePicker`,历史 `Table` 分页,删除 `Popconfirm`;`reports.css` 并入 token,删文件 | 定时报表 CRUD + 立即运行 |
| P4 | `rag/RagWorkspace.tsx` | `domain-grid` 三栏 + `analytics-*` + 原生控件 22 处 | 上传改 `Upload.Dragger`,文档列表 `Table`,分析区 `Card + Statistic`,设置进 `Form + Slider + Select` | 上传/检索/分析视图不断 |
| P5 | `mcp/McpWorkspace.tsx` + `McpOperations.tsx` + `MarketplaceView` + `DebugSandbox` + `SlaPanel` + `VersionLimits` | `domain-*` + `mcp-management-tabs` + `resource-panel` + 原生 40+35 处 | 顶部改 `Tabs`,服务列表 `Table`,资产生命周期 `Steps + Collapse`,弹窗全改 `Modal + Form`;6 处 `window.confirm` 全换 | 服务/版本/发布/回滚不断 |
| P6 | `graph/GraphWorkspace.tsx` | `domain-*` + `graph-*` + 画布 | 画布不动,两侧面板改 `Card + List + Descriptions`,同步条改 `Alert`,搜索改 `Input.Search` | 实体检索/对账不断 |
| P7 | `observatory/ObservatoryWorkspace.tsx` + `QueryAuditView` + `observatory.css` | `domain-*` + `obs-*` + 原生 14+18 处 | 问数区 `Form + Input.Search`,结果 `Table` 分页,审计 `Table + Drawer` 详情；`observatory.css` 收尾删文件 | 问数/审计链路可用 |
| P8 | `workflow/WorkflowWorkspace.tsx`(图书馆页) | `workflow-library-*` + `settings-modal` | 列表改 `Table` 分页 + `Input.Search`,新建改 `Modal + Form`;编辑器本体不动 | 新建/导入/删除不断 |
| P9 | `chat/*` + `components/*` | 已 antd 化,残留手写 class 与内联样式 | 只做 token 对齐:`SessionList` 内联样式收进 token/`Flex`,空态换 `Empty`,不改骨架 | 会话增删改查不断 |
| P10 | `apps/EmployeeApp.tsx` + `apps/PublishedAppsSection.tsx` | `Button/Input/Spin` 已有,缺空态与反馈 | 补 `Empty/Alert`,与 Studio 共用 theme 不共复杂组件 | 员工问答可用 |
| P11 | 共享组件 + CSS 清理 | 新增 `components/studio/*`,旧 CSS 约 13300 行 | 每页迁移完即删其专属旧 class,最后删 `studio-button/domain-*` 通用段 | `rg studio-button` 归零,CSS 行数下降 |

## 6. 共享组件(只建这三个,不搞组件库)

- `components/studio/StudioPageHeader.tsx`:props `{ eyebrow, title, description?, actions?, extra? }`,渲染 `Flex + Typography` 页头,管理页强制使用。
- `components/studio/StudioNotice.tsx`:props `{ notice: { type, text } | null }`,把 `workspace-notice` 映射为 `Alert(showIcon)`。
- `components/studio/confirmAction.tsx`:封装 `Modal.confirm({ title, content, okText, okButtonProps: { danger } })`,替换全部 `window.confirm`。
- 导入一律带 `.js` 后缀(沿用 `ChatResourceDrawer.js` 式 ESM 写法)；新组件配 `*.test.tsx`(vitest + `@testing-library/react` 若已装,否则纯函数测试)。

## 7. 执行计划

### Phase 0 — 立规矩(本方案 + 脚手架,不动业务)

- [x] 本方案文档定稿,映射表冻结。
- [x] 新增 `components/studio/{StudioPageHeader,StudioNotice,confirmAction}.tsx` + 单测,`typecheck + lint` 通过。
- [x] `main.tsx` 补 `Card/Table/Tabs/Segmented/Alert/Modal/Empty/Tag` 的 `components` token(只加 token,不改色板)。

### Phase 1 — 试点(`connectors`,整页端到端)

- [x] 页头 → `StudioPageHeader`；列表 → `Card + List`；表单 → `Form`；同步记录 → `Table` 分页；删除 → `Popconfirm`；notice → `Alert`。
- [x] 删 `connectors-*` 私有 class,验证新建/编辑/同步/删除。

### Phase 2 — 批量(`settings → reports → rag`)

- [x] 按映射表逐页替换,每页一个独立 commit,每页跑 `typecheck + lint + test + build`。
- [x] `reports.css` 在 P3 结束时删除(已随 `071faf3` 删除,当前 `styles/` 仅剩 `global.css + studio.css`)。

### Phase 3 — 深水(`mcp → graph → observatory`)

- [x] `mcp` 的弹窗与生命周期先行,画布类页面只动面板不动 canvas。
- [x] `observatory.css` 在 P7 结束时删除(已随 `5d846fc` 删除)。

### Phase 4 — 收尾(`workflow 图书馆页 → chat 对齐 → employee`)

- [x] 工作流图书馆页 + 访问点页 + MCP 服务页 + 编辑器工具条已 AntD 化；`workflow-panels.css` 只保留 canvas/节点必需样式,其余并入 token(待删旧 CSS 独立 commit)。
- [x] `rg -c "studio-button|workspace-notice|domain-header|resource-panel" src` 已归零；通用旧 CSS 已随 `bcaba75` 删除 904 条零引用规则(`studio.css` 10856→6226 行，存活 327 类白名单校验)；`vitest run` 37 文件 200 用例全绿。

## 8. 验收标准(每页通用)

- [x] 无 `studio-button` / `window.confirm`(仅 `confirmAction.tsx` 定义本身 1 处)；裸 `table/form/input/button` 仅剩画布内、导航轨、文件选择与消息气泡例外。
- [x] 主路径可点:列表 → 详情 → 新建/编辑 → 保存 → 反馈(message/Alert) → 删除确认,无白屏。
- [x] 空态(`Empty`)、加载(`Spin/Skeleton`)、错误(`Alert` + 重试)三态齐全。
- [x] `pnpm --filter @open-agent-tools/studio-web typecheck && pnpm --filter @open-agent-tools/studio-web lint && pnpm --filter @open-agent-tools/studio-web test && pnpm --filter @open-agent-tools/studio-web build` 全绿。
- [x] 明暗文案: destructive 操作有后果说明；`aria-label` 在图标按钮上齐全。

## 9. 风险与回滚

- 风险:`studio.css` 体量大(11915 行),误删通用 class 会波及多页 → 对策:按页删、删前 `rg` 确认零引用,每次只删一个文件段。
- 风险:antd `Table` 分页改变“全量展示”假设 → 对策:默认 `pageSize 20`,保留搜索过滤,超长列表加虚拟滚动前先分页顶住。
- 风险:`branding.primaryColor` 动态注入与 antd token 冲突 → 对策:只动 `main.tsx` 一处,不在页内覆盖 token。
- 回滚:每页独立 commit,`git revert` 单页即可；CSS 删除单独 commit,与 JSX 改动分离。

## 附录:关键文件速查

- 主题:`apps/studio-web/src/main.tsx:52-101`
- 导航:`apps/studio-web/src/App.tsx:62-200`
- 图标:`apps/studio-web/src/lib/icons.tsx`
- 标杆A:`apps/studio-web/src/features/workflow/WorkflowWorkspaceMain.tsx`,`apps/studio-web/src/features/workflow/NodeInspector.tsx`
- 标杆B:`apps/studio-web/src/features/chat/ChatWorkspace.tsx`,`apps/studio-web/src/features/chat/ChatResourceDrawer.tsx`,`apps/studio-web/src/components/SessionList.tsx`
- 待改造:`settings/SettingsWorkspace.tsx(1065 行)`,`mcp/McpWorkspace.tsx(1526 行)`,`rag/RagWorkspace.tsx(1252 行)`,`observatory/ObservatoryWorkspace.tsx(1053 行)`,`connectors/ConnectorsWorkspace.tsx(460 行)`,`reports/ReportsWorkspace.tsx(501 行)`,`graph/GraphWorkspace.tsx(637 行)`

