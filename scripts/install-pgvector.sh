#!/usr/bin/env bash
#
# 给「已在运行的 PostgreSQL 容器」安装 pgvector 扩展。
#
# 背景：官方 `postgres:16-alpine` 镜像不自带 pgvector；Alpine 仓库里的
# `postgresql-pgvector` 包是按 PostgreSQL 18 编译的，直接装到 16 上 `CREATE EXTENSION`
# 会失败（vector.so 版本不匹配）。所以这里按容器实际大版本从源码编译。
#
# 用法：
#   scripts/install-pgvector.sh <容器名> [数据库名]
#   scripts/install-pgvector.sh agent-demo-postgres mcp_management
#
# 注意：
# - 改动落在容器的可写层。`docker rm` 重建容器后需要重新执行本脚本 ——
#   要长期可复现，请改用官方镜像 `pgvector/pgvector:pg16`（自带扩展，见 README）。
# - 需要容器内可联网（拉取源码 + apk 装编译工具）。
# - 脚本幂等：已安装则跳过编译，只确保 `CREATE EXTENSION` 已执行。
set -euo pipefail

CONTAINER="${1:-}"
DATABASE="${2:-postgres}"
PGVECTOR_VERSION="${PGVECTOR_VERSION:-v0.8.1}"

if [[ -z "$CONTAINER" ]]; then
  echo "usage: $0 <container> [database]" >&2
  exit 2
fi

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "error: container '$CONTAINER' not found" >&2
  exit 1
fi

dexec() { docker exec "$CONTAINER" "$@"; }

echo "==> 检测容器内的 PostgreSQL 版本与发行版"
PG_VERSION="$(dexec sh -lc 'postgres -V' | sed -E 's/.*PostgreSQL\)? ([0-9]+).*/\1/')"
PG_CONFIG="$(dexec sh -lc 'command -v pg_config || echo /usr/local/bin/pg_config')"
echo "    postgres major: ${PG_VERSION}"
echo "    pg_config:      ${PG_CONFIG}"

is_alpine=0
if dexec sh -lc 'test -f /etc/alpine-release'; then is_alpine=1; fi

ext_installed() {
  # extension 文件（vector.control）存在即视为二进制已就位
  dexec sh -lc "ls \"\$(${PG_CONFIG} --sharedir)/extension/vector.control\" >/dev/null 2>&1"
}

if ext_installed; then
  echo "==> pgvector 扩展文件已存在，跳过编译"
else
  echo "==> 安装编译依赖"
  if [[ "$is_alpine" == "1" ]]; then
    dexec apk add --no-cache build-base git clang \
      "postgresql${PG_VERSION}-dev" >/dev/null
  else
    dexec sh -lc 'apt-get update -qq && apt-get install -y -qq build-essential git postgresql-server-dev-all' >/dev/null
  fi

  echo "==> 编译并安装 pgvector ${PGVECTOR_VERSION}（匹配 PG${PG_VERSION}）"
  dexec sh -lc "
    set -e
    rm -rf /tmp/pgvector-src
    git clone --depth 1 --branch ${PGVECTOR_VERSION} https://github.com/pgvector/pgvector.git /tmp/pgvector-src >/dev/null 2>&1
    cd /tmp/pgvector-src
    make PG_CONFIG=${PG_CONFIG} -j\"\$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)\" >/dev/null
    # bitcode 安装步骤依赖 llvm-lto，缺失时会报错；扩展真正的 so 与 sql 已经装好，允许失败。
    make PG_CONFIG=${PG_CONFIG} install >/dev/null 2>&1 || true
    # 补齐扩展 SQL/control 文件（install 部分失败时的兜底）
    cp sql/vector--*.sql \"\$(${PG_CONFIG} --sharedir)/extension/\"
    cp vector.control \"\$(${PG_CONFIG} --sharedir)/extension/\"
  "
fi

echo "==> 在数据库 '${DATABASE}' 上启用扩展"
dexec psql -U postgres -d "$DATABASE" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null
dexec psql -U postgres -d "$DATABASE" -tAc \
  "SELECT 'pgvector ' || extversion FROM pg_extension WHERE extname = 'vector'"

echo "==> 完成。验证："
echo "    docker exec ${CONTAINER} psql -U postgres -d ${DATABASE} -c 'SELECT extversion FROM pg_extension WHERE extname = '\"'\"'vector'\"'\"';'"
