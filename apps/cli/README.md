# CLI Agent（@open-agent-tools/cli）

[English](./README_EN.md) | [平台总览](../../README.md)

基于 LangChain 与 [Deep Agents](https://github.com/langchain-ai/deepagents) 的命令行 coding agent。支持流式对话、文件系统与 Shell 工具调用、SQLite 历史会话持久化、长期记忆、项目上下文和 MCP 服务接入。

## 功能特性

- ✅ 流式对话输出
- ✅ Deep Agents 驱动：文件读写、Shell 执行、任务规划（Todo）、子代理委派与异步任务
- ✅ 内置 `getCurrentTime` 工具与长期记忆（`memory_*`）工具
- ✅ MCP 服务动态加载与工具调用（信任确认、按工具授权）
- ✅ SQLite 历史会话持久化（`sessions` / `messages` / `audit_log` 三表）
- ✅ 会话管理（创建、加载、删除、自动标题）
- ✅ 长期记忆（file-backed + SQLite 索引，global/project 双作用域）
- ✅ 项目上下文（`AGENT.md` 扫描生成，`/init`、`/context` 管理）
- ✅ 危险工具授权确认（`a=允许 / n=拒绝 / A=本次会话始终允许`）
- ✅ 工具调用审计日志
- ✅ Markdown 渲染与发送后的等待反馈动画（Ora）

## 安装

在仓库根目录使用 pnpm 安装：

```bash
pnpm install
```

构建 CLI 及其依赖（`@open-agent-tools/deepagent` 等）：

```bash
pnpm --filter @open-agent-tools/cli build
```

## 使用

### 开发模式

```bash
pnpm --filter @open-agent-tools/cli dev
```

### 生产模式

```bash
pnpm --filter @open-agent-tools/cli start
```

### 全局命令行

也可以直接运行编译产物：

```bash
node apps/cli/dist/index.js
```

或在 `apps/cli` 目录内：

```bash
pnpm dev
pnpm start
```

## 可用命令

| 命令 | 说明 |
|------|------|
| `/new` | 创建新会话 |
| `/list` | 列出所有历史会话 |
| `/load <id>` | 加载指定会话（支持部分 ID） |
| `/delete <id>` | 删除指定会话 |
| `/tools` | 列出当前可用工具（含来源 `mcp:server`） |
| `/init` | 扫描仓库结构，生成项目上下文（`AGENT.md`） |
| `/context` | 查看当前已加载的项目上下文 |
| `/memory` | 长期记忆子命令（`search` / `list` / `read` / `review` / `accept` / `daily` / `organize` / `quota` / `wipe`） |
| `/help` | 显示帮助信息 |
| `exit` | 退出程序 |

## 工具

Agent 由 Deep Agents（`deepagents`）驱动，内置以下工具：

| 工具 | 说明 | 授权 |
|------|------|------|
| `ls` / `glob` / `grep` / `read_file` | 文件系统读取与检索 | 自动 |
| `write_file` / `edit_file` | 写入与编辑文件 | 逐次确认 |
| `execute` | 执行 shell 命令 | 逐次确认 |
| `write_todos` | 任务规划清单 | 自动 |
| `task` | 委派子代理 | 自动 |
| `start_async_task` / `check_async_task` / `update_async_task` / `cancel_async_task` / `list_async_tasks` | 异步子任务管理 | 自动 |
| `getCurrentTime` / `memory_*` / MCP 工具 | 时间、长期记忆、MCP 服务 | 按配置 |

危险工具（`write_file`、`edit_file`、`execute`）运行前会请求授权：`a=允许 / n=拒绝 / A=本次会话始终允许`。

## 使用示例

### 自动创建会话

```
Enter: 你好
自动创建新会话: abc123...
AI -> 你好！我是你的 AI 助手...
```

### 手动创建会话

```
Enter: /new
✓ 新会话已创建: xyz789...
```

### 查看历史会话

```
Enter: /list

历史会话:
→ abc123de 你好 (2026-07-30 14:30:00)
  xyz789ab 计算 1+1 (2026-07-30 14:25:00)
```

### 加载历史会话

```
Enter: /load xyz789
✓ 已加载会话: 计算 1+1 (3 条消息)
```

### 删除会话

```
Enter: /delete xyz789
✓ 会话已删除: xyz789
```

## 环境变量

按约定顺序加载：`.env` → `.env.local` → `.env.development` → `.env.development.local`（后加载的覆盖先前的）。可在仓库根目录或 `apps/cli` 目录下创建：

```env
OPENAI_API_KEY=your_api_key
OPENAI_API_BASE_URL=https://api.openai.com/v1
OPENAI_API_MODEL=gpt-4
SQLITE_PATH=./data/chat.sqlite  # 可选，默认在 apps/cli/data/chat.sqlite
```

## 数据存储

所有会话数据存储在 SQLite 数据库中，默认路径：

```
apps/cli/data/chat.sqlite
```

可通过 `SQLITE_PATH` 环境变量自定义路径。长期记忆的物理文件位于项目级 `.agent-demo/memory/` 与用户级 `~/.config/agent-demo/memory/`。

## 开发

### 类型检查

```bash
pnpm --filter @open-agent-tools/cli typecheck
```

### 代码格式化

```bash
pnpm --filter @open-agent-tools/cli format
```

### Lint

```bash
pnpm --filter @open-agent-tools/cli lint
```

### 测试

```bash
pnpm --filter @open-agent-tools/cli test
```

## 技术栈

- **LangChain**: AI 应用框架
- **Deep Agents**: 多 Agent 编排与内置工具
- **OpenAI**: LLM 提供商
- **SQLite（`node:sqlite`）**: 会话与记忆持久化
- **Chalk**: 终端颜色
- **Ora**: 加载动画
- **Marked / Marked Terminal**: Markdown 渲染
- **Zod**: 输入校验
