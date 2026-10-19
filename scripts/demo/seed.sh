#!/usr/bin/env bash
# scripts/demo/seed.sh
# 演示数据准备(幂等:可重复执行,不会重复创建同名资源)。
#
# 做三件事:
#   1) 把 docs/demo/fixtures/knowledge/*.txt 上传到 rag-server(POST /api/documents,幂等入库);
#   2) 在 Agent Server 发布一个员工入口应用(GET 查重后 POST /api/admin/published-apps);
#   3) 在 MCP Control Plane 建一个演示客户端并授权(POST/PUT /api/admin/mcp/*)。
# 可选:若本机有 mysql 客户端且配置了 REPORT_DATABASE_URL,导入 docs/demo/fixtures/schema.sql。
#
# 缺少外部依赖时给出清晰提示并跳过,**不会静默失败、不会删除任何数据**。
#
# 用法:
#   bash scripts/demo/seed.sh
#   bash scripts/demo/seed.sh --dry-run   # 只打印将要执行的请求
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
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

FIXTURES="$REPO_ROOT/docs/demo/fixtures/knowledge"
SCHEMA_SQL="$REPO_ROOT/docs/demo/fixtures/schema.sql"
LINE="------------------------------------------------------------"
DEMO_APP_SLUG="demo-knowledge"
DEMO_APP_NAME="星桥科技 · 制度问答(演示)"
MCP_CLIENT_NAME="demo-client"

read_env_value() {
  file="$1"
  key="$2"
  [ -f "$file" ] || {
    printf ''
    return 0
  }
  match="$(grep -E "^[[:space:]]*${key}=" "$file" | head -n 1 || true)"
  value="${match#*=}"
  value="${value%$'\r'}"
  printf '%s' "$value"
}

# JSON 取值:优先 python3,退化到 grep -o。
json_get() {
  json="$1"
  key="$2"
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$json" | python3 -c "import sys,json;
try:
    data=json.load(sys.stdin)
except Exception:
    sys.exit(0)
def walk(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if k=='$key': print(v); return
            walk(v)
    elif isinstance(o,list):
        for i in o: walk(i)
walk(data)" 2>/dev/null || true
  else
    printf '%s' "$json" | grep -o "\"$key\"[^,}]*" | head -n 1 | cut -d: -f2- | tr -d '",' || true
  fi
}

server_env="$REPO_ROOT/apps/server/.env"
rag_env="$REPO_ROOT/apps/rag-server/.env"
worker_env="$REPO_ROOT/apps/mcp-worker/.env"

SERVER_PORT="$(read_env_value "$server_env" PORT)"
[ -n "$SERVER_PORT" ] || SERVER_PORT=3000
STUDIO_TOKEN="$(read_env_value "$server_env" STUDIO_API_TOKEN)"
[ -n "$STUDIO_TOKEN" ] || STUDIO_TOKEN="$(read_env_value "$server_env" SERVER_API_TOKEN)"

RAG_PORT="$(read_env_value "$rag_env" RAG_API_PORT)"
[ -n "$RAG_PORT" ] || RAG_PORT=4001
RAG_ADMIN_TOKEN="$(read_env_value "$rag_env" RAG_ADMIN_TOKEN)"

WORKER_PORT="$(read_env_value "$worker_env" PORT)"
[ -n "$WORKER_PORT" ] || WORKER_PORT=4200

SERVER_URL="http://127.0.0.1:${SERVER_PORT}"
RAG_URL="http://127.0.0.1:${RAG_PORT}"
MCP_ADMIN_URL="http://127.0.0.1:${WORKER_PORT}"

printf '%s\n' "$LINE"
printf 'Open Agent Tools 演示数据准备 (dry-run=%s)\n' "$DRY_RUN"
printf '  server   : %s\n' "$SERVER_URL"
printf '  rag      : %s\n' "$RAG_URL"
printf '  mcp admin: %s\n' "$MCP_ADMIN_URL"
printf '%s\n' "$LINE"

reachable() {
  url="$1"
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS --max-time 4 "$url" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# 1. 知识库文档
# ---------------------------------------------------------------------------
printf '\n[1/4] 上传知识库文档\n'
if [ ! -d "$FIXTURES" ]; then
  printf '  FAIL  未找到 fixtures 目录: %s\n' "$FIXTURES"
  exit 1
fi
if ! reachable "$RAG_URL/api/health"; then
  printf '  SKIP  rag-server 未就绪(%s/api/health 无响应)。\n' "$RAG_URL"
  printf '        请先启动:pnpm --filter @open-agent-tools/rag-server start\n'
  printf '        并确认 apps/rag-server/.env 的 RAG_ADMIN_TOKEN 已配置且与服务端一致。\n'
else
  for doc in "$FIXTURES"/*.txt; do
    [ -e "$doc" ] || continue
    name="$(basename "$doc")"
    if [ "$DRY_RUN" = "1" ]; then
      printf '  [dry-run] curl -fsS -X POST %s/api/documents -H "Authorization: Bearer <RAG_ADMIN_TOKEN>" -F files=@%s\n' \
        "$RAG_URL" "docs/demo/fixtures/knowledge/$name"
      continue
    fi
    resp="$(curl -fsS --max-time 60 -X POST "$RAG_URL/api/documents" \
      -H "Authorization: Bearer ${RAG_ADMIN_TOKEN}" \
      -F "files=@${doc}" 2>&1 || true)"
    if [ -n "$resp" ]; then
      printf '  ok    %s\n' "$name"
    else
      printf '  FAIL  %s 上传失败(检查 RAG_ADMIN_TOKEN 是否与服务端一致)\n' "$name"
    fi
  done
  printf '  提示:文档 source 名即文件名,发布应用时按 source 绑定。\n'
fi

# ---------------------------------------------------------------------------
# 2. 发布员工入口应用
# ---------------------------------------------------------------------------
printf '\n[2/4] 发布员工入口应用(幂等)\n'
auth_header=()
[ -n "$STUDIO_TOKEN" ] && auth_header=(-H "Authorization: Bearer ${STUDIO_TOKEN}")
if ! reachable "$SERVER_URL/health"; then
  printf '  SKIP  Agent Server 未就绪(%s/health 无响应)。\n' "$SERVER_URL"
  printf '        请先启动:pnpm --filter @open-agent-tools/server start\n'
else
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] GET  %s/api/admin/published-apps(查重)\n' "$SERVER_URL"
    printf '  [dry-run] POST %s/api/admin/published-apps (slug=%s)\n' "$SERVER_URL" "$DEMO_APP_SLUG"
  else
    existing="$(curl -fsS --max-time 10 "${auth_header[@]}" "$SERVER_URL/api/admin/published-apps" 2>/dev/null || true)"
    if printf '%s' "$existing" | grep -q "\"$DEMO_APP_SLUG\""; then
      printf '  ok    应用已存在(slug=%s),跳过创建\n' "$DEMO_APP_SLUG"
    else
      body="$(cat <<JSON
{
  "name": "$DEMO_APP_NAME",
  "slug": "$DEMO_APP_SLUG",
  "description": "演示用员工入口:绑定制度类知识库文档",
  "welcome": "你好,我是星桥科技制度助手,可以问我差旅报销、员工福利、信息安全等相关问题。",
  "suggestions": [
    { "title": "住宿标准", "prompt": "一线城市出差住宿标准是多少?" },
    { "title": "年假天数", "prompt": "入职满 3 年的员工年假有多少天?" },
    { "title": "答不出演示", "prompt": "2027 年海外差旅补贴标准是多少?" }
  ],
  "resources": {
    "rag": {
      "sources": ["01-差旅报销制度.txt", "02-员工福利手册.txt"],
      "topK": 5
    }
  },
  "accessMode": "public"
}
JSON
)"
      resp="$(curl -fsS --max-time 15 -X POST "$SERVER_URL/api/admin/published-apps" \
        -H "Content-Type: application/json" "${auth_header[@]}" \
        --data "$body" 2>&1 || true)"
      if printf '%s' "$resp" | grep -q '"app"'; then
        printf '  ok    已创建应用 slug=%s\n' "$DEMO_APP_SLUG"
      else
        printf '  FAIL  创建应用失败:%s\n' "$resp"
        printf '        若提示 unauthorized,请在 apps/server/.env 配置 STUDIO_API_TOKEN 并保持一致。\n'
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 3. MCP 客户端与授权
# ---------------------------------------------------------------------------
printf '\n[3/4] MCP 演示客户端与授权(幂等)\n'
if ! reachable "$MCP_ADMIN_URL/health"; then
  printf '  SKIP  MCP Control Plane 未就绪(%s/health 无响应)。\n' "$MCP_ADMIN_URL"
  printf '        请先启动:pnpm --filter @open-agent-tools/mcp-worker start:admin\n'
  printf '        (需要 PostgreSQL + Redis,见 docs/deploy/docker-compose.prod.yml)\n'
else
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] GET  %s/api/admin/mcp/clients(查重)\n' "$MCP_ADMIN_URL"
    printf '  [dry-run] POST %s/api/admin/mcp/clients (name=%s)\n' "$MCP_ADMIN_URL" "$MCP_CLIENT_NAME"
  else
    clients="$(curl -fsS --max-time 10 "$MCP_ADMIN_URL/api/admin/mcp/clients" 2>/dev/null || true)"
    if [ -z "$clients" ]; then
      printf '  FAIL  无法读取客户端列表(可能未配置 OIDC,生产需要 OIDC admin JWT)\n'
      printf '        本地 OIDC 未启用时该接口是开放的;若返回 {error:UNAUTHORIZED} 请检查部署形态。\n'
    elif printf '%s' "$clients" | grep -q "\"$MCP_CLIENT_NAME\""; then
      printf '  ok    客户端已存在(name=%s),跳过创建\n' "$MCP_CLIENT_NAME"
    else
      resp="$(curl -fsS --max-time 15 -X POST "$MCP_ADMIN_URL/api/admin/mcp/clients" \
        -H "Content-Type: application/json" \
        --data "{\"name\":\"$MCP_CLIENT_NAME\"}" 2>&1 || true)"
      if printf '%s' "$resp" | grep -q '"client"'; then
        printf '  ok    已创建 MCP 客户端 name=%s\n' "$MCP_CLIENT_NAME"
        printf '        下一步:在 Studio「MCP」工作台为该客户端签发 API Key 并授权工具。\n'
      else
        printf '  FAIL  创建客户端失败:%s\n' "$resp"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 4. 问数样例库(可选)
# ---------------------------------------------------------------------------
printf '\n[4/4] 问数样例库(可选)\n'
report_url="$(read_env_value "$server_env" REPORT_DATABASE_URL)"
if ! command -v mysql >/dev/null 2>&1; then
  printf '  SKIP  未安装 mysql 客户端,跳过 schema.sql 导入。\n'
  printf '        手动导入:mysql -h <host> -u <user> -p <database> < docs/demo/fixtures/schema.sql\n'
elif [ -z "$report_url" ] || printf '%s' "$report_url" | grep -q "readonly:password@host"; then
  printf '  SKIP  apps/server/.env 的 REPORT_DATABASE_URL 仍是占位符。\n'
  printf '        配置指向 demo 库的只读连接后重跑,或手动导入 schema.sql。\n'
elif [ "$DRY_RUN" = "1" ]; then
  printf '  [dry-run] mysql <REPORT_DATABASE_URL> < docs/demo/fixtures/schema.sql\n'
else
  printf '  提示:REPORT_DATABASE_URL 已配置,但本脚本不解析其中的口令,避免误连生产库。\n'
  printf '        请手动执行:mysql -h <host> -u <user> -p <database> < docs/demo/fixtures/schema.sql\n'
fi

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
printf '\n%s\n' "$LINE"
printf '演示入口:\n'
printf '  管理台       : %s\n' "$SERVER_URL 后接前端 5173"
printf '  员工入口     : <前端地址>/#/app/%s\n' "$DEMO_APP_SLUG"
printf '  演示手册     : docs/demo/README.md\n'
printf '%s\n' "$LINE"
exit 0
