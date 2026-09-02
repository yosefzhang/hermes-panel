# Hermes Panel

Hermes Panel 是 Hermes Agent 的 Web 管理面板，用于集中查看和管理 Hermes 的配置、Profiles、模型、渠道、Memory、Skills 与 Token 用量。它运行在 Hermes Agent 所在机器上，直接读写 Hermes 数据目录（默认 `~/.hermes`）下的文件，并支持多个 Panel 之间同步统计数据。

## 技术栈

- 后端：Python 3.11+、FastAPI、Uvicorn、Pydantic Settings、JSON/JSONL 文件存储、`ruamel.yaml`
- 前端：Next.js 14（React 18）、TypeScript、Tailwind CSS v4、Zustand、ECharts、Ant Design、Radix UI

## 前置要求

- Python 3.11+
- Node.js 18+ 和 npm

## 快速开始

### 本地开发

```bash
git clone https://github.com/yosefzhang/hermes-panel.git
cd hermes-panel

./deploy.sh dev
```

`deploy.sh` 会在首次运行时自动创建 Python 虚拟环境、安装后端与前端依赖，然后启动：

- 前端：http://localhost:8090（Next.js dev）
- 后端 API：http://127.0.0.1:8650（仅本机回环，前端把 `/api` 转发到后端）

### 生产运行

```bash
./deploy.sh product
```

会先构建前端，再根据配置中的 `port` 启动服务，默认地址 http://0.0.0.0:8090。

### Docker 部署

```bash
docker compose up -d --build
```

Docker 部署需要宿主机提供 `./config.yaml` 与 `./data` 挂载目录，并挂载 Hermes 数据目录 `~/.hermes`。

## 首次启动

首次启动会在当前目录自动生成最小化 `config.yaml`、创建数据目录 `./data`，并创建默认管理员：

- 用户名：`admin`
- 密码：`admin`

JWT 密钥会在首次启动时自动生成 32 字节随机值并写回 `config.yaml`。

## 配置

配置文件固定为当前工作目录下的 `config.yaml`（本地开发即项目根目录；Docker 中挂载到容器 `/app/config.yaml`）。文件缺失时启动会自动生成最小化初始配置；所有 Panel 配置均从该 YAML 文件读取。

常用配置：

```yaml
hermes_path: ~/.hermes
data_dir: ./data
port: 8090

sync:
  send:
    enabled: false
    endpoints:
      - endpoint: https://panel.example.com/api/v1/sync/
        token: replace-me
    interval: 600
  receive:
    enabled: false
    token: replace-me
```

`data_dir` 默认 `./data`，也可用环境变量 `HERMES_PANEL_DATA_DIR` 覆盖为绝对路径。

## 数据同步

发送端支持多个目标，每个目标独立使用自己的 Token：

```yaml
sync:
  send:
    enabled: true
    endpoints:
      - endpoint: https://panel-a.example.com/api/v1/sync/
        token: token-a
      - endpoint: https://panel-b.example.com/api/v1/sync/
        token: token-b
    interval: 600
  receive:
    enabled: true
    token: token-for-this-panel
```

保存同步配置后会立即尝试推送一次；后台随后按 `sync.send.interval` 周期推送。接收端点是：

```text
POST /api/v1/sync/
Authorization: Bearer <sync.receive.token>
```

接收到的数据以 JSON/JSONL 文件保存在 Panel 自己的数据目录（默认 `./data`），不会写入 Hermes Agent 的 `state.db`。超过 24 小时未更新的 Profile 统计会自动清理。

如果只需要从其他机器推送数据，可以使用独立脚本：

```bash
python3 scripts/push_sync.py \
  --url https://panel.example.com/api/v1/sync/ \
  --token <receive-token>
```

脚本也支持 JSON 配置、指定 Hermes 数据目录和 Profile 选择：

```bash
python3 scripts/push_sync.py --config ./push_sync.json
```

## 项目结构

- `backend/main.py`：FastAPI 应用、生命周期与后台采集任务
- `backend/api/`：按功能拆分的 API 路由（`auth.py`、`hermes.py`、`system.py`）
- `backend/services/`：Profile、统计、同步与配置等业务逻辑（`profile.py`、`system.py`）
- `backend/auth.py`：认证、授权与用户管理
- `backend/store.py`：JSON/JSONL 存储层与数据模型
- `backend/config.py`：Panel 配置加载与持久化
- `backend/tests/`：后端测试
- `frontend/`：Next.js 前端（App Router，页面位于 `src/app/`）
- `scripts/push_sync.py`：无需安装 Panel 的独立同步推送脚本
- `deploy.sh`：开发、生产与停止命令
- `Dockerfile` / `docker-compose.yml`：容器化部署
- `config.yaml.example`：Panel 配置示例

## 常用命令

```bash
./deploy.sh dev       # 开发模式（后端热重载 + Next.js dev）
./deploy.sh product   # 构建前端并启动生产服务
./deploy.sh stop      # 停止所有相关进程
```

后端测试：

```bash
.venv/bin/python -m pytest backend/tests -q
```

> 更多面向编程 Agent 的代码结构、服务边界和修改约定见 [AGENTS.md](AGENTS.md)。