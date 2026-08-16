# function-tools（自定义 Tools 聚合目录）

**自定义 function tools** 的聚合目录（monorepo 约定目录）：每个子目录是一个可独立发布的
MCP 工具包，作为 function tool 暴露给 AI 调用。

> **粒度**：本目录下每个工具包（`<tool-name>/`）即一个 function tool 的发布粒度——
> 自包含 `mcp.json + package.json + package-lock.json + src/`，由本目录的交互式
> `build-package` 统一打包，走同一条控制面发布链路。
>
> ⚠️ **数据库类工具注意**：Worker 执行容器 `network: "none"` 且不注入环境变量，
> 工具容器无法外连数据库。若需要 SQL 查询能力，当前方案是 Agent 侧（apps/server）
> 内置 `query_sql` 直连数据库，见 `apps/server/src/function_tools/sqlQueryBuiltin.ts`。

工具包是自包含的 ZIP 交付物：`mcp.json + package.json + package-lock.json + src/`，
由 MCP 控制面发布、Worker 构建为容器镜像、Gateway 鉴权后执行。

## 目录约定

```text
packages/function-tools/
├── package.json            # 脚本入口：build-package / clean
├── scripts/
│   ├── build-package.mjs   # 交互式打包：列出工具 → 选择 → 打包
│   └── lib/packager.mjs    # 打包引擎（校验/剔除缓存/ZIP 验证）
├── dist/                   # 打包产物目录（已 gitignore，供 MCP 上传）
├── README.md               # 本文件：目录约定
# （SQL 查询能力由 apps/server 内置 query_sql 提供，见 sqlQueryBuiltin.ts）
└── <tool-name>/            # 每个工具一个子目录
    ├── mcp.json            # 服务清单：tools / prompts / limits / entry
    ├── package.json        # "type": "module"，入口 src/index.js
    ├── package-lock.json   # 必填，随包提交（Worker 校验 lockfile v2/v3 且根 name/version 一致）
    ├── Dockerfile          # 可选：本地测试镜像（生产镜像由 Worker 构建，不会被打包）
    ├── src/                # 源码，入口导出 handlers
    ├── migrations/         # 配套数据库迁移（手动执行，不会被打包）
    └── test/               # 单元 / 集成测试（不会被打包）
```

## 新增一个工具（步骤）

1. `mkdir packages/function-tools/<tool-name>`，参考 `runtimes/nodejs/fixtures/echo-package/` 结构；
2. 编写 `mcp.json`（真实格式参考 `runtimes/nodejs/fixtures/echo-package/mcp.json`，勿用简化格式）；
3. 编写 `src/`，入口 `src/index.js` 必须 `export const handlers = { ... }`；
4. 生成 lockfile：`npm install --package-lock-only --ignore-scripts`；
5. 本地跑测试：`node --test "test/*.test.js"`；
6. 打包：`pnpm --filter @open-agent-tools/function-tools build-package`（交互式选择，产物 `dist/<tool-name>.zip`）；
7. 上传：在 MCP 控制面「upload-package（上传工具包）」处上传 `dist/` 下的 zip；
8. 控制面发布：build → publish（见开发文档 §8.2）；
9. 创建 Client + API Key + Grant，绑定到 Studio 聊天或 CLI agent。

## 打包（build-package，交互式）

```bash
# 交互式：终端列出 function-tools 下所有工具 → 选择序号 → 打包
pnpm --filter @open-agent-tools/function-tools build-package
```

交互示例：

```text
[build-package] function-tools 下的工具：
  1) expense-query-tool   tools=[query_expense_approval]
  2) sales-report-tool    tools=[query_sales_report]
  0) 全部打包
请选择要打包的工具（序号可逗号/空格分隔，支持区间如 1-3；回车=全部；q=退出）：
```

选择方式：

| 输入 | 含义 |
|---|---|
| `1` | 只打包第 1 个工具 |
| `1,3` / `1 3` / `1-3` | 打包多个（逗号/空格分隔，支持区间） |
| 回车 / `0` / `all` | 全部打包 |
| `q` / `quit` / `exit` | 取消退出 |

非交互/CI 场景（stdin 非终端）请显式指定：

```bash
# 非交互：直接打包指定工具（按目录名）
pnpm --filter @open-agent-tools/function-tools build-package -- --tool=<tool-name>

# 先清空 dist/ 再打包
pnpm --filter @open-agent-tools/function-tools build-package -- --clean
```

**打包内容**：`mcp.json + package.json + package-lock.json + src/` 等运行必需文件（entry 及其依赖）。

**自动排除**（打包时删除的非必要缓存/本地文件）：`node_modules/`、`scripts/`、`test/`、`migrations/`、`Dockerfile`、`README.md`、`dist/`、`*.zip/*.tgz/*.tar` 等压缩包、`*.tsbuildinfo`、`.DS_Store`、`.git` 及各类临时/备份文件。

**打包前自动本地校验**（对齐 Worker `apps/mcp-worker/src/infrastructure/node-package.ts` 规则）：
必需文件齐全、`"type": "module"`、lockfile v2/v3 且根 name/version 与 package.json 一致、至少声明一个 Tool、entry 存在。

**产物安全**：ZIP 条目为相对路径、无符号链接/特殊文件、无 `..`/反斜杠等不安全路径，兼容 Worker 的 `inspectZipArchive` 校验（路径安全 / 仅 store+deflate 压缩 / 大小限制）。上传后 Worker 仍会做全量检查。

## 硬约束（Worker 校验规则见 `apps/mcp-worker/src/infrastructure/node-package.ts`）

- `mcp.json` 必须声明至少一个 Tool（`TOOLS_REQUIRED`）；
- `package.json` 必须 `"type": "module"`（Node 20 ESM/npm only），不允许 CommonJS；
- `package-lock.json` **必填**，npm lockfile v2/v3，根节点 `name`/`version` 必须与 package.json 一致；
- 工具包**自包含**：依赖只允许公共 npm 包（如 `pg`），不能依赖 monorepo 内部 workspace 包；
- handler 签名 `async (args, context) => CallToolResult`，返回 `{ content: [{ type: "text", text }] }`，纯 JSON、≤1MB；
- 执行容器默认无网络（`limits.network: "none"`），需要访问数据库的工具须走网络策略（见开发文档 §5）。

## 关联文档

- 完整设计与调用方式：[docs/AI报表SQL查询工具开发文档.md](../../docs/AI报表SQL查询工具开发文档.md)
- SQL 查询工具（Agent 侧内置）：[sqlQueryBuiltin.ts](../../apps/server/src/function_tools/sqlQueryBuiltin.ts)
