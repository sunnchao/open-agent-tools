# 项目上下文 (AGENT.md)

> 本文件由 open-agent-tools 的 `/init` 命令自动生成。你可以直接编辑它，补充项目约定、常用命令、注意事项等。
> 它会在每次会话开始时自动加载到系统提示词中，让 agent 立刻理解本仓库。

- **项目名称**: cli
- **技术栈**: LangChain, Zod, TypeScript
- **文件总数**: 24
- **主要语言**: TypeScript/.ts: 15, JSON/.json: 5, Markdown/.md: 2, .local/.local: 1, .sqlite/.sqlite: 1

## 目录结构

```
cli
├── data/
│   └── chat.sqlite
├── src/
│   ├── tools/
│   │   ├── fs.ts
│   │   ├── index.ts
│   │   ├── mcp.ts
│   │   ├── permissions.ts
│   │   ├── shell.ts
│   │   └── time.ts
│   ├── utils/
│   │   ├── index.ts
│   │   ├── llm-input.json
│   │   ├── llm-output.json
│   │   ├── markdown.ts
│   │   └── tools.ts
│   ├── agent.ts
│   ├── commands.ts
│   ├── context.ts
│   ├── db.ts
│   ├── index.ts
│   └── systemPrompt.ts
├── .env.local
├── AGENT.md
├── mcp.example.json
├── package.json
├── README.md
└── tsconfig.json
```

## 关键文件

### README.md

````
# CLI Agent Demo

基于 LangChain 的命令行 AI 助手，支持历史会话存储和工具调用。

## 功能特性

- ✅ 流式对话输出
- ✅ 工具调用支持
- ✅ SQLite 历史会话持久化
- ✅ 会话管理（创建、加载、删除）
- ✅ Markdown 渲染
- ✅ 自动会话标题生成

## 安装

```bash
npm install
npm run build
````

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

| 命令           | 说明                        |
| -------------- | --------------------------- |
| `/new`         | 创建新会话                  |
| `/list`        | 列出所有历史会话            |
| `/load <id>`   | 加载指定会话（支持部分 ID） |
| `/delete <id>` | 删除指定会话                |
| `/help`        | 显示帮助信息                |
| `exit`         | 退出程序                    |

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

```

### mcp.example.json

```

{
"mcpServers": [
{
"name": "open-agent-tools-mcp",
"transport": "stdio",
"command": "npx",
"args": ["tsx", "apps/mcp-server/src/index.ts"],
"env": {}
}
]
}

```

### package.json

```

{
"name": "@open-agent-tools/cli",
"version": "0.0.0",
"private": true,
"type": "module",
"bin": {
"open-agent-tools": "./dist/index.js"
},
"scripts": {
"dev": "tsx watch src/index.ts",
"build": "tsc -p tsconfig.json",
"start": "node dist/index.js",
"typecheck": "tsc -p tsconfig.json --noEmit",
"lint": "eslint .",
"lint:fix": "eslint . --fix",
"format": "prettier --write .",
"format:check": "prettier --check .",
"test": "tsx --test",
"clean": "rm -rf dist"
},
"dependencies": {
"@open-agent-tools/shared": "workspace:*",
"@modelcontextprotocol/sdk": "^1.29.0",
"@langchain/core": "^1.2.3",
"@langchain/openai": "^1.5.5",
"chalk": "^6.0.0",
"dotenv": "^16.6.1",
"marked": "^15.0.12",
"marked-terminal": "^7.3.0",
"ora": "^9.4.1",
"zod": "^4.4.3"
},
"devDependencies": {
"@types/marked-terminal": "^6.1.1"
}
}

```

### tsconfig.json

```

{
"extends": "../../tsconfig.base.json",
"compilerOptions": {
"moduleResolution": "nodenext",
"allowImportingTsExtensions": true,
"rewriteRelativeImportExtensions": true,
"outDir": "dist",
"rootDir": "src"
},
"include": ["src/**/*.ts"],
"references": [{ "path": "../../packages/shared" }]
}

```

---
*生成时间: 2026-07-31T01:34:47.737Z*
```
