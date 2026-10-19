#!/usr/bin/env bash
# scripts/deploy/verify.sh
# 只读健康检查:不修改任何文件、不重启服务、不写数据库、不删任何东西。
# 用法:
#   bash scripts/deploy/verify.sh
#   bash scripts/deploy/verify.sh --dry-run   # 只打印将要执行的检查,不发起任何请求
#
# 退出码:0 = 全部通过;1 = 存在 FAIL;2 = 参数错误。
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
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

# 可用环境变量覆盖,便于在容器/远端复跑。
SERVER_BASE_URL="${SERVER_BASE_URL:-http://127.0.0.1:3000}"
RAG_BASE_URL="${RAG_BASE_URL:-http://127.0.0.1:4001}"
GATEWAY_BASE_URL="${GATEWAY_BASE_URL:-http://127.0.0.1:4100}"
MCP_ADMIN_BASE_URL="${MCP_ADMIN_BASE_URL:-http://127.0.0.1:4200}"
STUDIO_WEB_URL="${STUDIO_WEB_URL:-http://127.0.0.1:5173}"
CURL_TIMEOUT="${CURL_TIMEOUT:-5}"

PASS=0
FAIL=0
SKIP=0
LINE="------------------------------------------------------------"

pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf 'SKIP  %s\n' "$1"; }
info() { printf '      %s\n' "$1"; }
section() {
  printf '%s\n' "$LINE"
  printf '%s\n' "$1"
}

printf '%s\n' "$LINE"
printf 'Open Agent Tools 部署健康检查 (dry-run=%s)\n' "$DRY_RUN"
printf '仓库根目录: %s\n' "$REPO_ROOT"
printf '%s\n' "$LINE"

# ---------------------------------------------------------------------------
# 1. 必需环境变量(以仓库 .env.example 为事实来源,只做「缺失/占位符」判断)
# ---------------------------------------------------------------------------

read_env_value() {
  # 从 .env 文件里取一个 KEY 的值(忽略注释行),不存在则输出空串。
  file="$1"
  key="$2"
  [ -f "$file" ] || {
    printf ''
    return 0
  }
  # 只取最前面的 KEY=...,去掉行尾 CR;不 eval,避免注入。
  match="$(grep -E "^[[:space:]]*${key}=" "$file" | head -n 1 || true)"
  value="${match#*=}"
  value="${value%$'\r'}"
  printf '%s' "$value"
}

is_placeholder() {
  # 判定明显的占位符/未填写;空串也算缺失,由调用方决定是否必填。
  value="$1"
  case "$value" in
    "" | changeme | change-me | change-me-in-production | change-runtime-token | change-admin-token | \
      openssl-rand-hex-32 | xxx | your-token-here)
      return 0
      ;;
  esac
  return 1
}

check_env_file() {
  # check_env_file <服务名> <env 文件> <KEY:必填|可选> ...
  label="$1"
  file="$2"
  shift 2
  if [ ! -f "$file" ]; then
    skip "$label: 未找到配置 ${file#"$REPO_ROOT"/}(服务可能未部署到本机)"
    return 0
  fi
  for spec in "$@"; do
    key="${spec%%:*}"
    need="${spec##*:}"
    value="$(read_env_value "$file" "$key")"
    if is_placeholder "$value"; then
      if [ "$need" = "required" ]; then
        fail "$label: 必需变量 $key 缺失或仍为占位符 (${file#"$REPO_ROOT"/})"
      else
        info "$label: 可选变量 $key 未配置"
      fi
    else
      pass "$label: $key 已配置"
    fi
  done
}

section "[1/4] 环境变量检查"
check_env_file "server" "$REPO_ROOT/apps/server/.env" \
  "CONFIG_SECRETS_ENCRYPTION_KEY:required" "STUDIO_API_TOKEN:optional"
check_env_file "rag-server" "$REPO_ROOT/apps/rag-server/.env" \
  "RAG_RUNTIME_TOKEN:required" "RAG_ADMIN_TOKEN:required"
check_env_file "mcp-worker" "$REPO_ROOT/apps/mcp-worker/.env" \
  "DATABASE_URL:required" "REDIS_URL:required" "ARTIFACT_S3_BUCKET:required"
check_env_file "mcp-server" "$REPO_ROOT/apps/mcp-server/.env" \
  "DATABASE_URL:required" "REDIS_URL:required"

# ---------------------------------------------------------------------------
# 2. 端口监听
# ---------------------------------------------------------------------------
section "[2/4] 端口监听检查"

check_port() {
  name="$1"
  port="$2"
  if [ "$DRY_RUN" = "1" ]; then
    skip "$name: [dry-run] 将检查端口 $port 是否监听"
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      pass "$name: 端口 $port 已监听"
    else
      fail "$name: 端口 $port 未监听(服务未启动?)"
    fi
  elif command -v nc >/dev/null 2>&1; then
    if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
      pass "$name: 端口 $port 已监听"
    else
      fail "$name: 端口 $port 未监听(服务未启动?)"
    fi
  else
    skip "$name: 无 lsof/nc,无法检查端口 $port"
  fi
}

check_port "server (Agent Server / Studio 后端)" 3000
check_port "rag-server (RAG 服务)" 4001
check_port "mcp-server (Gateway 数据面)" 4100
check_port "mcp-worker (Control Plane 管理面)" 4200
check_port "studio-web (前端)" 5173

# ---------------------------------------------------------------------------
# 3. 健康端点(只读 GET)
# ---------------------------------------------------------------------------
section "[3/4] 健康端点检查"

check_health() {
  name="$1"
  url="$2"
  if [ "$DRY_RUN" = "1" ]; then
    skip "$name: [dry-run] 将执行 curl -fsS --max-time $CURL_TIMEOUT $url"
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    skip "$name: 未安装 curl,跳过 $url"
    return 0
  fi
  body="$(curl -fsS --max-time "$CURL_TIMEOUT" "$url" 2>/dev/null || true)"
  if [ -n "$body" ]; then
    pass "$name: $url -> $body"
  else
    fail "$name: $url 无响应或非 2xx"
  fi
}

check_health "server" "$SERVER_BASE_URL/health"
check_health "rag-server" "$RAG_BASE_URL/api/health"
check_health "mcp-server (Gateway)" "$GATEWAY_BASE_URL/health"
check_health "mcp-worker (管理面)" "$MCP_ADMIN_BASE_URL/health"

# ---------------------------------------------------------------------------
# 4. rag-server 双 token 专项(生产缺任一即拒绝启动)
# ---------------------------------------------------------------------------
section "[4/4] rag-server 双 token 与安全项"

rag_env="$REPO_ROOT/apps/rag-server/.env"
runtime_token="$(read_env_value "$rag_env" RAG_RUNTIME_TOKEN)"
admin_token="$(read_env_value "$rag_env" RAG_ADMIN_TOKEN)"
if is_placeholder "$runtime_token" || is_placeholder "$admin_token"; then
  fail "rag-server: RAG_RUNTIME_TOKEN / RAG_ADMIN_TOKEN 不完整(NODE_ENV=production 下服务会拒绝启动)"
else
  if [ "$runtime_token" = "$admin_token" ]; then
    fail "rag-server: 运行时 token 与 admin token 相同,应使用不同值"
  else
    pass "rag-server: runtime / admin 双 token 已分别配置"
  fi
fi

rag_bind="$(read_env_value "$rag_env" RAG_BIND_HOST)"
if [ -z "$rag_bind" ]; then
  info "rag-server: RAG_BIND_HOST 未显式设置(默认 127.0.0.1,仅本机可达)"
elif [ "$rag_bind" = "0.0.0.0" ]; then
  info "rag-server: RAG_BIND_HOST=0.0.0.0,请确认只在私有网络暴露且已配置双 token"
fi

server_env="$REPO_ROOT/apps/server/.env"
studio_token="$(read_env_value "$server_env" STUDIO_API_TOKEN)"
if is_placeholder "$studio_token"; then
  info "server: STUDIO_API_TOKEN 未配置 —— 仅限本机开发;对外部署必须配置"
else
  pass "server: STUDIO_API_TOKEN 已配置"
fi

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
printf '%s\n' "$LINE"
printf '结果:PASS=%d  FAIL=%d  SKIP=%d\n' "$PASS" "$FAIL" "$SKIP"
if [ "$DRY_RUN" = "1" ]; then
  printf '模式:dry-run(未发起任何请求、未读取服务状态)\n'
  printf '      dry-run 仍会做静态 env 校验,因此配置缺失会导致非零退出码。\n'
fi
if [ "$FAIL" -gt 0 ]; then
  printf '结论:存在 %d 项失败,请按上面的 FAIL 行排查。\n' "$FAIL"
  printf '%s\n' "$LINE"
  exit 1
fi
printf '结论:检查通过(FAIL=0)。\n'
printf '%s\n' "$LINE"
exit 0
