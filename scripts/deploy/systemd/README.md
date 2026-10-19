# systemd unit 模板

本目录是**模板**,不直接可用。安装前必须替换占位符:

| 占位符 | 含义 | 示例 |
|--------|------|------|
| `__REPO_ROOT__` | 仓库绝对路径 | `/opt/open-agent-tools` |
| `__USER__` | 运行服务的系统账号(建议非 root 专用户) | `openagent` |

替换示例(在仓库根目录执行,先备份原始模板):

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin openagent
sudo mkdir -p /etc/systemd/system
for unit in scripts/deploy/systemd/open-agent-*.service; do
  sed -e "s#__REPO_ROOT__#$(pwd)#g" -e 's#__USER__#openagent#g' "$unit" \
    | sudo tee "/etc/systemd/system/$(basename "$unit")" >/dev/null
done
sudo systemctl daemon-reload
```

## 单元清单

| unit | 进程 | 端口 | 备注 |
|------|------|------|------|
| `open-agent-server.service` | `apps/server` | 3000 | 先 `pnpm --filter @open-agent-tools/server build` |
| `open-agent-rag.service` | `apps/rag-server` | 4001 | 用 `tsx` 直接跑 TS,无 dist 产物 |
| `open-agent-mcp-admin.service` | `apps/mcp-worker` 管理面 | 4200 | 依赖 PostgreSQL/Redis/MinIO |
| `open-agent-mcp-worker.service` | `apps/mcp-worker` 后台 Worker | 无 | **需要 Docker**,加固相对放宽 |
| `open-agent-mcp-gateway.service` | `apps/mcp-server` | 4100 | 依赖 PostgreSQL/Redis |
| `open-agent-studio-web.service` | `vite preview` | 5173 | 兜底;生产推荐 nginx 托管 `dist/` |

## 关于 `EnvironmentFile=`

systemd 的 `EnvironmentFile` **不是** dotenv:

- 不支持 `export KEY=value`(只能写 `KEY=value`);
- 不做 shell 变量展开,不支持 `${OTHER_VAR}` 引用;
- 值里含 `#` 会当注释,需加引号:`KEY="a#b"`;
- 不会自动读取 `.env.local` / `.env.production`。

因此仓库里的 `apps/*/.env.example` 可以直接改名为 `.env` 使用(内容符合该格式),
但若你手动加了 `export` 或 shell 展开,请改回纯 `KEY=value`。

## 常用操作

```bash
sudo systemctl status  open-agent-server
sudo systemctl restart open-agent-mcp-admin
journalctl -u open-agent-server -f          # 看日志
journalctl -u open-agent-mcp-worker -n 200  # 看最近 200 行
```

> **未验证**:本目录的 unit 模板未在真实 systemd 主机上安装运行过(开发环境为 macOS,
> 无 systemd)。`ExecStart` 中使用的命令(如 `pnpm --filter ... start`)与仓库
> `package.json` 一致,但 `ProtectSystem` / `ReadWritePaths` 等加固路径需要按实际
> 安装目录与数据目录核对后再启用。
