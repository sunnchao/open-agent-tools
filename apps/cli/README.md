# CLI Agent Demo

基于 LangChain 的命令行 AI 助手，支持历史会话存储和工具调用。

## 功能特性

- ✅ 流式对话输出
- ✅ 工具调用支持
- ✅ SQLite 历史会话持久化
- ✅ 会话管理（创建、加载、删除）
- ✅ Markdown 渲染
- ✅ 自动会话标题生成
- ✅ 发送后的等待反馈动画（Ora）

## 安装

```bash
npm install
npm run build
```

## 使用

### 开发模式

```bash
npm run dev
```

### 生产模式

```bash
npm start
```

或直接运行：

```bash
node dist/index.js
```

## 可用命令

| 命令 | 说明 |
|------|------|
| `/new` | 创建新会话 |
| `/list` | 列出所有历史会话 |
| `/load <id>` | 加载指定会话（支持部分 ID） |
| `/delete <id>` | 删除指定会话 |
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

在项目根目录或 `apps/cli` 目录下创建 `.env.local` 文件：

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

可通过 `SQLITE_PATH` 环境变量自定义路径。

## 开发

### 类型检查

```bash
npm run typecheck
```

### 代码格式化

```bash
npm run format
```

### Lint

```bash
npm run lint
```

## 技术栈

- **LangChain**: AI 应用框架
- **OpenAI**: LLM 提供商
- **SQLite**: 会话持久化
- **Chalk**: 终端颜色
- **Ora**: 加载动画
- **Marked**: Markdown 渲染
