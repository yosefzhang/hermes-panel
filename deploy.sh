#!/usr/bin/env bash
#
# Hermes Panel 部署脚本
#
# 用法：
#   ./deploy.sh dev      开发模式（后端热重载 + Next.js dev 服务器）
#   ./deploy.sh product  生产模式（构建前端 + 启动服务）
#   ./deploy.sh stop     停止所有相关进程
#
# 单端口设计：后端 FastAPI 仅监听本机 127.0.0.1:8650，对外只暴露一个
# 前端端口：dev=8090，product=面板配置的 port（默认 8090）。
# 前端 Next.js 通过 rewrites 把 /api 内部转发给后端。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

BACKEND_HOST="127.0.0.1"
BACKEND_PORT="8650"
DEV_FRONTEND_PORT="8090"

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }

panel_port() {
  .venv/bin/python -c 'from backend.config import get_settings; print(get_settings().port)'
}

ensure_backend() {
  if [ ! -f .venv/bin/activate ]; then
    log "创建 Python 虚拟环境..."
    python3 -m venv .venv
  fi
  if ! .venv/bin/python -c "import fastapi, uvicorn" >/dev/null 2>&1; then
    log "安装后端依赖..."
    .venv/bin/python -m pip install --retries 5 --timeout 120 -e ".[dev]"
  fi
}

ensure_frontend() {
  if [ ! -x frontend/node_modules/.bin/next ]; then
    log "安装前端依赖..."
    (cd frontend && npm install)
  fi
}

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -ti tcp:"$port" 2>/dev/null || fuser -n tcp "$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    log "停止端口 :$port 上的进程 -> $(echo "$pids" | tr '\n' ' ')"
    fuser -k -TERM -n tcp "$port" >/dev/null 2>&1 || kill $pids 2>/dev/null || true
    if fuser -n tcp "$port" >/dev/null 2>&1; then
      fuser -k -KILL -n tcp "$port" >/dev/null 2>&1 || true
    fi
  fi
}

cmd_dev() {
  ensure_backend
  ensure_frontend
  log "后端 API  : http://${BACKEND_HOST}:${BACKEND_PORT}（仅本机）"
  log "前端 dev  : http://localhost:${DEV_FRONTEND_PORT}"
  trap 'kill 0' EXIT
  (. .venv/bin/activate && uvicorn backend.main:app --host "$BACKEND_HOST" --port "$BACKEND_PORT" --reload) &
  (cd frontend && npm run dev) &
  wait
}

cmd_product() {
  ensure_backend
  ensure_frontend
  local port
  port="$(panel_port)"
  log "构建前端..."
  (cd frontend && npm run build)
  log "后端 API  : http://${BACKEND_HOST}:${BACKEND_PORT}（仅本机）"
  log "前端      : http://localhost:${port}"
  trap 'kill 0' EXIT
  (. .venv/bin/activate && uvicorn backend.main:app --host "$BACKEND_HOST" --port "$BACKEND_PORT") &
  (cd frontend && npm run start -- --port "$port") &
  wait
}

cmd_stop() {
  log "停止 Hermes Panel 进程..."
  kill_port "$BACKEND_PORT"
  kill_port "$DEV_FRONTEND_PORT"
  # dev 模式的 uvicorn --reload 主进程不监听端口，端口杀不到，需按命令行清理
  pkill -f "uvicorn backend.main:app" 2>/dev/null || true
  if [ -x .venv/bin/python ]; then
    local pp
    pp="$(panel_port 2>/dev/null || echo 8090)"
    kill_port "$pp"
  fi
}

case "${1:-}" in
  dev)     cmd_dev ;;
  product) cmd_product ;;
  stop)    cmd_stop ;;
  *)
    echo "用法: $0 {dev|product|stop}"
    echo "  dev       开发模式（后端热重载 + Next.js dev）"
    echo "  product   生产模式（构建并启动）"
    echo "  stop      停止所有相关进程"
    exit 1
    ;;
esac