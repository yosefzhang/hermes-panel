# syntax=docker/dockerfile:1

# ── 阶段 1：构建前端（Next.js standalone） ────────────────────────────────
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /app/frontend

# 先安装依赖，再拷贝源码，充分利用 Docker layer 缓存
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


# ── 阶段 2：运行时 ────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# FastAPI 后端需要 Python 3.11（Debian bookworm 自带 3.11）
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/*

# 安装后端依赖及 backend 包
COPY pyproject.toml ./
COPY backend/ ./backend/
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir .

# 拷贝 Next.js standalone 运行产物
COPY --from=frontend-builder /app/frontend/.next/standalone ./frontend/
COPY --from=frontend-builder /app/frontend/.next/static ./frontend/.next/static

# 数据根目录：JSON 数据、日志、账号都持久化到 ./data（当前工作目录，容器内即 /app/data），
# 由 docker-compose 挂载宿主机 ./data 持久化；也可通过 HERMES_PANEL_DATA_DIR 覆盖。
# config.yaml 默认读取当前工作目录 ./config.yaml（容器内即 /app/config.yaml），
# 由 docker-compose 挂载宿主机 ./config.yaml 持久化；缺失时自动生成最小化配置。
# 前端对外端口（可用 -e PORT=... 覆盖）；后端仅监听容器内回环 127.0.0.1:8650。
ENV PORT=8090 \
    HOSTNAME=0.0.0.0

EXPOSE 8090

CMD ["sh", "-c", "/opt/venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8650 & exec node /app/frontend/server.js"]