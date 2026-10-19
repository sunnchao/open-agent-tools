#!/usr/bin/env bash
# scripts/deploy/bootstrap.sh
# 一键引导:前置条件检查 -> 校验/生成 .env -> 安装依赖 -> build:deps -> build -> 打印启动命令。
# 幂等:可重复执行。绝不 rm -rf,绝不覆盖已存在的 .env。
# 用法:
#   bash scripts/deploy/bootstrap.sh
#   bash scripts/deploy/bootstrap.sh --dry-run   # 只打印将要执行的命令
set -euo pipefail

DRY_RUN=0
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    -h | --help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

LINE="------------------------------------------------------------"
WARN=0
FAIL=0

step() {
  printf '\n%s\n' "$LINE"
  printf '>> %s\n' "$1"
}
ok() { printf '   ok    %s\n' "$1"; }
warn() { WARN=$((WARN + 1)); printf '   warn  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '   fail  %s\n' "$1"; }
run() {
  # 统一执行入口:dru-run 下只打印。
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] %s\n' "$*"
    return 0
  fi
  printf '   exec    %s\n' "$*"
  "$@"
}

printf '%s\n' "$LINE"
printf 'Open Agent Tools 部署引导 (dry-run=%s)\n' "$DRY_RUN"
printf '仓库根目录: %s\n' "$REPO_ROOT"
printf '%s\n' "$LINE"

# ---------------------------------------------------------------------------
# 1. 前置条件检查(只读,不做改动)
# ---------------------------------------------------------------------------
step "1/5 前置条件检查"

if command -v node >/dev/null 2>&1; then
  node_version="$(node -v)"
  ok "node $node_version"
  node_major="$(printf '%s' "$node_version" | sed 's/^v//' | cut -d. -f1)"
  if [ "${node_major:-0}" -lt 20 ]; then
    bad "Node 版本过低(需要 20+,仓库 engines 要求 >=22.5,建议 Node 22 LTS)"
  elif [ "${node_major:-0}" -lt 22 ]; then
    warn "Node $node_version:仓库 engines.node 为 >=22.5,建议升级到 Node 22 LTS"
  fi
else
  bad "未找到 node(需要 Node 20+,建议 Node 22 LTS)"
fi

if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm -v)"
else
  bad "未找到 pnpm(需要 pnpm 10+,可用 corepack enable && corepack prepare pnpm@10.32.1 --activate)"
fi

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    ok "docker + docker compose 可用"
  else
    warn "docker 存在但 docker compose 不可用(基础设施编排需要)"
  fi
else
  warn "未找到 docker —— 仅影响 mcp-worker 后台 Worker 的容器构建,MVP 可暂不部署 Worker"
fi

if command -v psql >/dev/null 2>&1; then
  ok "psql 可用(用于 mcp-worker / gateway 的 PostgreSQL)"
else
  warn "未找到 psql —— mcp-worker / gateway 需要 PostgreSQL 15+,可直接用 docker compose 起"
fi

if command -v redis-cli >/dev/null 2>&1; then
  ok "redis-cli 可用"
else
  warn "未找到 redis-cli —— mcp-worker / gateway 需要 Redis,可直接用 docker compose 起"
fi

# ---------------------------------------------------------------------------
# 2. .env 校验(只创建缺失文件,绝不覆盖)
# ---------------------------------------------------------------------------
step "2/5 环境文件校验(不覆盖已有 .env)"

ensure_env() {
  # ensure_env <服务目录>
  dir="$1"
  env_file="$dir/.env"
  example="$dir/.env.example"
  if [ -f "$env_file" ]; then
    ok "$dir/.env 已存在,保留不动"
    return 0
  fi
  if [ ! -f "$example" ]; then
    warn "$dir 缺少 .env.example,跳过"
    return 0
  fi
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] 将执行 cp %s %s(仅在 .env 不存在时)\n' "${example#"$REPO_ROOT"/}" "$dir/.env"
    return 0
  fi
  cp "$example" "$env_file"
  ok "已从 .env.example 生成 %s/.env —— 请填写其中的 secret 后再启动" "$dir"
}

ensure_env "apps/server"
ensure_env "apps/rag-server"
ensure_env "apps/mcp-worker"
ensure_env "apps/mcp-server"

printf '   提示:server 的 CONFIG_SECRETS_ENCRYPTION_KEY 用 `openssl rand -hex 32` 生成;\n'
printf '        rag-server 生产环境必须配置 RAG_RUNTIME_TOKEN 与 RAG_ADMIN_TOKEN(两者不同);\n'
printf '        这些 secret 只放服务端 .env,绝不放进 VITE_ 变量或浏览器。\n'

# ---------------------------------------------------------------------------
# 3. 安装依赖
# ---------------------------------------------------------------------------
step "3/5 安装依赖"
if [ -f "$REPO_ROOT/pnpm-lock.yaml" ]; then
  run pnpm install --frozen-lockfile
else
  run pnpm install
fi

# ---------------------------------------------------------------------------
# 4. 构建共享依赖 + 各包
# ---------------------------------------------------------------------------
step "4/5 构建"
if [ "$SKIP_BUILD" = "1" ]; then
  warn "已指定 --skip-build,跳过构建"
else
  run pnpm build:deps
  run pnpm build
fi

# ---------------------------------------------------------------------------
# 5. 打印下一步
# ---------------------------------------------------------------------------
step "5/5 下一步:启动命令"
cat <<'EOF'
   基础设施(PostgreSQL / Redis / MinIO):
     docker compose -f scripts/deploy/docker-compose.prod.yml up -d

   开发/内网直跑(四个后端进程,各开一个终端):
     pnpm --filter @open-agent-tools/server start
     pnpm --filter @open-agent-tools/rag-server start
     pnpm --filter @open-agent-tools/mcp-server start
     pnpm --filter @open-agent-tools/mcp-worker start:admin
  (mcp-worker 后台 Worker 需要 Docker + 镜像,见 docs/deploy/private-deployment.md)

   前端:
     pnpm --filter @open-agent-tools/studio-web build
     pnpm --filter @open-agent-tools/studio-web start   # vite preview

   健康检查:
     bash scripts/deploy/verify.sh
EOF

printf '\n%s\n' "$LINE"
printf '引导结束:FAIL=%d  WARN=%d\n' "$FAIL" "$WARN"
if [ "$DRY_RUN" = "1" ]; then
  printf '模式:dry-run(未做任何改动)\n'
fi
printf '%s\n' "$LINE"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
