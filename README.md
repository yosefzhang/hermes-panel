# Hermes Panel

Hermes Panel 是一个 Web 控制面板，用于查看和管理 [Hermes Agent](https://hermes-agent.nousresearch.com) 的配置、profiles、skills、plugins、渠道、模型、token 用量与系统状态。

后端为 FastAPI，直接读写 Hermes Agent 数据目录（`~/.hermes`）下的 `config.yaml` / `.env` / `state.db`，并通过本地 `hermes` CLI 执行 plugins、skills、gateway 等操作。前端为 React 18 + Vite + Ant Design 5。

## 功能

- JWT 登录，admin / user 两级权限，普通用户按 profile 授权隔离
- 多 profile 管理：`default` 及 `~/.hermes/profiles/<name>` 下的独立配置
- `config.yaml` 的 section 编辑与原始 YAML 编辑（写入前校验 + 自动备份，保留最近 5 份）
- `.env` 掩码查看、单条与批量增删改
- Skills 管理：本地扫描 + `hermes skills list` CLI 合并，识别 builtin / modified / hub / local / external 来源
- Plugins 管理：调用 CLI 列表 / 启用 / 禁用 / 删除，按一级分类归并
- 模型与 Provider 配置：主 provider、custom_providers、fallback，内置 provider 预设与连通性测试
- 消息渠道配置：telegram / discord / slack / feishu / weixin 等，支持 config 与 `.env` 两种来源
- Memory 配置与记忆文件预览
- Gateway 状态查询与启动 / 停止 / 重启
- Hermes `state.db` 只读 token 聚合（按模型 / provider / 日期）
- `psutil` 系统指标采集与历史记录（含 WebSocket 实时推送）
- Hermes 版本检查与在线升级（admin）

## 快速开始

### 前置要求

- Python 3.11+
- Node.js 18+ & npm
- 已安装并可在 PATH 中调用的 `hermes` CLI（plugins / skills / gateway 功能依赖）

### 安装

```bash
git clone https://github.com/YOUR_USERNAME/hermes-panel.git
cd hermes-panel
make install
```

### 开发模式

```bash
make dev
```

同时启动：

- 后端：http://127.0.0.1:8650（FastAPI + Uvicorn，热重载）
- 前端：http://127.0.0.1:5173（Vite dev server，HMR）

首次启动会自动创建默认管理员 `admin` / `admin`。生产环境请通过环境变量修改：

```bash
export HERMES_PANEL_DEFAULT_ADMIN_PASSWORD='your-secure-password'
```

### 生产构建

```bash
make build
. .venv/bin/activate
uvicorn backend.main:app --host 0.0.0.0 --port 8650
```

构建产物在 `frontend/dist/`，后端在该目录存在时自动 serve 静态文件并支持 SPA 路由回退。

## 环境变量

将 `.env.example` 复制到 `~/.config/hermes-panel/.env` 并按需修改，启动时会自动加载（可用 `HERMES_PANEL_ENV` 覆盖路径）。已存在的 shell 环境变量优先级高于该文件。

```bash
mkdir -p ~/.config/hermes-panel && cp .env.example ~/.config/hermes-panel/.env
```

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `HERMES_HOME` | Hermes Agent 数据目录 | `~/.hermes` |
| `HERMES_PANEL_ENV` | Panel 自身 `.env` 文件路径 | `~/.config/hermes-panel/.env` |
| `HERMES_PANEL_DB` | Panel 自身 SQLite 数据库路径（用户、系统指标） | `~/.config/hermes-panel/control.db` |
| `HERMES_PANEL_JWT_SECRET` | JWT 签名密钥（生产环境必须修改） | `change-me-in-production` |
| `HERMES_PANEL_DEFAULT_ADMIN_PASSWORD` | 首次启动创建的 admin 密码 | `admin` |

## 常用命令

```bash
make dev          # 启动开发环境（后端 + 前端）
make dev-backend  # 仅启动后端
make dev-frontend # 仅启动前端
make build        # 构建前端
make test         # 运行后端测试（pytest）
make lint         # ruff + tsc 类型检查
make clean        # 清理构建产物
make stop         # 停止占用 8650 / 5173 端口的进程
```

## API 概览

所有接口挂载在 `/api/v1` 前缀下，除登录外均需 `Authorization: Bearer <token>`。

| 前缀 | 说明 |
|------|------|
| `/auth` | 登录、当前用户、登出 |
| `/users` | 用户增删改查、改密码（admin） |
| `/config` | config.yaml section / 原始 YAML 读写 |
| `/env` | `.env` 详情、批量更新（`/env/batch`）、单条增删改 |
| `/env/plain` | 扁平 `KEY=value` 视图 |
| `/profile-files` | profile 下 config / .env / SOUL / USER / MEMORY 文件（.env 掩码） |
| `/profiles` | profile 列表与详情 |
| `/skills` | skills 列表、读写、启用禁用、导入、external-dirs |
| `/plugins` | 插件列表、启用、禁用、删除 |
| `/models` | 模型 section、providers、预设、连通性测试 |
| `/channels` | 渠道配置（config + .env） |
| `/memory` | memory 配置与记忆文件预览 |
| `/tokens` | token 用量聚合、趋势、仪表盘 |
| `/system` | 系统指标、历史、版本、Hermes 更新（admin），`/ws/system` 实时推送 |
| `/gateway` | 网关状态与启停控制 |

## 项目结构

```
hermes-panel/
├── backend/
│   ├── api/               # FastAPI 路由（按资源拆分）
│   ├── auth/              # JWT 认证与依赖
│   ├── db/                # control.db 数据层与 schema
│   ├── services/          # 业务逻辑
│   │   ├── atomic_io.py       # 原子写文件
│   │   ├── cli_runner.py      # hermes CLI 定位与 profile 命令前缀
│   │   ├── env_service.py     # .env 读写 + 目录元数据
│   │   ├── yaml_service.py    # config.yaml 读写（备份 + 校验）
│   │   ├── profile_service.py # profile 路径解析
│   │   ├── skill_service.py   # skills 扫描与来源判定
│   │   ├── gateway_service.py # 网关状态与控制
│   │   ├── state_reader.py    # state.db 只读 token 聚合
│   │   ├── system_monitor.py  # psutil 指标采集
│   │   └── hermes_*_service.py# Hermes 信息与升级
│   └── main.py            # FastAPI 入口与静态文件 serve
├── frontend/
│   └── src/
│       ├── pages/         # 页面组件
│       ├── components/    # 通用组件
│       ├── store/         # Zustand 状态管理
│       ├── hooks/         # 通用 hooks
│       └── api/           # Axios API 客户端
├── Makefile               # 统一命令入口
└── pyproject.toml         # Python 依赖与工具配置
```

## License

MIT
