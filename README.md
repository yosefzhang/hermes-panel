# Hermes Panel

Hermes Panel 是一个 Web 控制面板，用于查看和管理 [Hermes Agent](https://hermes-agent.nousresearch.com) 的配置、profiles、skills、plugins、渠道、模型、token 用量与系统状态。

- 后端：FastAPI + Uvicorn，直接读写 Hermes 数据目录（`~/.hermes`）下的 `config.yaml` / `.env` / `state.db`，并通过本地 `hermes` CLI 执行插件、skill、gateway 等操作。
- 前端：React 18 + Vite + TypeScript + Tailwind CSS v4 + shadcn/ui，状态管理使用 Zustand，图表使用 ECharts，UI 组件结合 Ant Design 与 Radix UI。

## 快速开始

### 前置要求

- Python 3.11+（见 `pyproject.toml` 的 `requires-python`）
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

首次启动会自动将 `.env.example` 复制到 `~/.config/hermes-panel/.env` 并据此创建默认管理员 `admin`。默认密码在 `.env.example` 中为 `changeme`，若 `HERMES_PANEL_DEFAULT_ADMIN_PASSWORD` 环境变量未设置则使用该值；生产环境务必通过环境变量修改：

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

## 常用命令

```bash
make dev          # 启动开发环境（后端 + 前端）
make dev-backend  # 仅启动后端
make dev-frontend # 仅启动前端
make build        # 构建前端
make test         # 运行后端测试（pytest backend/tests）
make lint         # ruff + tsc 类型检查
make clean        # 清理构建产物
make stop         # 停止占用 8650 / 5173 端口的进程
```

## 配置

将 `.env.example` 复制到 `~/.config/hermes-panel/.env` 并按需修改，启动时会自动加载（可用 `HERMES_PANEL_ENV` 覆盖路径）。已存在的 shell 环境变量优先级高于该文件；若该文件不存在，会自动从项目根目录的 `.env.example` 拷贝生成。

```bash
mkdir -p ~/.config/hermes-panel && cp .env.example ~/.config/hermes-panel/.env
```

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `HERMES_HOME` | Hermes Agent 数据目录（启动时强制设置为 `~/.hermes`，并清除 `HERMES_PROFILE`，使面板不绑定任何 profile） | `~/.hermes` |
| `HERMES_PANEL_ENV` | Panel 自身 `.env` 文件路径 | `~/.config/hermes-panel/.env` |
| `HERMES_PANEL_DB` | Panel 自身 SQLite 数据库路径 | `~/.config/hermes-panel/hermes-panel.db` |
| `HERMES_PANEL_JWT_SECRET` | JWT 签名密钥（生产环境必须修改） | `change-me-in-production-hermes-panel-secret-key`（`.env.example` 中为 `changeme`） |
| `HERMES_PANEL_DEFAULT_ADMIN_PASSWORD` | 首次启动创建的 admin 密码（也兼容旧变量名 `HERMES_PANEL_DEFAULT_PASSWORD`） | `admin`（`.env.example` 中为 `changeme`） |
| `HERMES_PANEL_LOG_FILE` | 后端日志文件路径 | `~/.config/hermes-panel/hermes-panel.log` |
| `HERMES_PANEL_LOG_LEVEL` | 后端日志级别 | `INFO` |
| `HERMES_PANEL_LOG_MAX_BYTES` | 单个日志文件最大大小（字节） | `5242880`（5 MB） |
| `HERMES_PANEL_LOG_BACKUP_COUNT` | 保留的归档日志文件数 | `5` |
| `SYNC_ENABLED` | 是否向目标面板推送数据 | `false` |
| `SYNC_RECEIVE_ENABLED` | 是否接收其它面板推送的数据 | `false` |
| `SYNC_TARGET_URL` | 数据同步目标面板地址 | - |
| `SYNC_TOKEN` | 数据同步鉴权 token（仅发送端用作 `Authorization: Bearer` 请求头） | - |
| `SYNC_INTERVAL` | 数据同步推送间隔（秒） | `60` |

配置加载与更新逻辑见 [`backend/config.py`](backend/config.py)。

## 日志

Hermes Panel 后端使用 RotatingFileHandler 将日志写入文件，同时输出到 stderr 以便在终端查看。默认日志文件位于 `~/.config/hermes-panel/hermes-panel.log`，单个文件最大 5 MB，最多保留 5 个归档文件。

可通过 `HERMES_PANEL_LOG_LEVEL` 调整日志级别（如 `DEBUG`、`INFO`、`WARNING`、`ERROR`）。

## 数据库

Hermes Panel 使用单一 SQLite 数据库文件存储所有自身数据，路径由 `HERMES_PANEL_DB` 控制，默认位于 `~/.config/hermes-panel/hermes-panel.db`。表结构定义在 [`backend/db/database.py`](backend/db/database.py) 中。

数据库包含两类表：

### 1. 控制表（control）

| 表名 | 用途 | 关键字段 |
|------|------|----------|
| `users` | 登录用户与权限 | `username`, `password_hash`, `role` (`admin`/`user`), `profiles`（可访问 profile 列表，JSON 数组，`["*"]` 表示全部） |
| `system_metrics` | 系统资源历史 | `timestamp`, `cpu_percent`, `memory_percent`, `memory_used_gb`, `memory_total_gb`, `disk_percent`, `net_bytes_sent`, `net_bytes_recv`, `load_avg_1m` |
| `audit_logs` | 操作审计日志 | `timestamp`, `actor`, `action`, `target_type`, `target_id`, `details`, `success`, `ip_address` |

### 2. Profiles 表（profiles）

`host_info` 与 `profile_stats` 已合并为一张表，每一行代表**某个主机上的某个 profile**，同时携带该主机的元数据（Hermes 版本、系统版本等）。这是多主机汇总与数据同步的核心表。

| 字段 | 说明 |
|------|------|
| `host` | 主机名 |
| `username` | 用户名 |
| `ip` | IP 地址 |
| `profile_name` | profile 名称 |
| `path` | profile 路径 |
| `gateway_status` | 该 profile 下 gateway 运行状态 |
| `session_count` | 会话数 |
| `total_tokens` | 总 token 数 |
| `total_input_tokens` | 输入 token 数 |
| `total_output_tokens` | 输出 token 数 |
| `cache_hit_rate` | 缓存命中率 |
| `model_top5` | token 用量 Top5 模型，JSON 数组 |
| `provider_top5` | token 用量 Top5 provider，JSON 数组 |
| `daily_tokens` | 最近 15 天每日 token 用量，JSON 数组 |
| `hermes_version` | Hermes CLI 版本（独立列） |
| `components` | 除 Hermes 外的各组件版本信息，JSON |
| `updated_at` | 更新时间戳 |

唯一约束：`UNIQUE(host, username, ip, profile_name)`。

主机元数据以**反规范化**方式存储在每个 profile 行上；查询所有主机时，按 `(host, username, ip)` 分组即可。

## 功能模块与对应代码

### 认证与权限

- JWT 登录/登出/当前用户：[backend/api/auth.py](backend/api/auth.py)
- JWT 依赖与鉴权：[backend/auth/dependencies.py](backend/auth/dependencies.py)
- 用户增删改查、改密码（admin）：[backend/api/users.py](backend/api/users.py)
- 默认 admin 初始化：[backend/db/database.py](backend/db/database.py) `init_database()`

### Profile 与配置管理

- Profile 列表与路径解析：[backend/api/profiles.py](backend/api/profiles.py)、[backend/services/profile_service.py](backend/services/profile_service.py)
- `config.yaml` section 编辑与原始 YAML 编辑：[backend/api/config.py](backend/api/config.py)、[backend/services/yaml_service.py](backend/services/yaml_service.py)
- `.env` 掩码查看与增删改：[backend/api/profile_files.py](backend/api/profile_files.py)、[backend/services/env_service.py](backend/services/env_service.py)
- 写入前校验与自动备份：[backend/services/yaml_service.py](backend/services/yaml_service.py)、[backend/services/atomic_io.py](backend/services/atomic_io.py)

### Skills 与 Plugins

- Skills 列表、来源判定、启用/禁用：[backend/api/skills.py](backend/api/skills.py)、[backend/services/skill_service.py](backend/services/skill_service.py)
- Plugins 列表、启用、禁用、删除：[backend/api/plugins.py](backend/api/plugins.py)
- 调用 Hermes CLI 时的 profile 前缀定位：[backend/services/cli_runner.py](backend/services/cli_runner.py)
- 统一的子进程执行封装：[backend/services/subprocess_utils.py](backend/services/subprocess_utils.py)

### 模型、渠道、Memory

- 模型配置与 provider 管理：[backend/api/models_config.py](backend/api/models_config.py)
- 消息渠道配置（config + .env）：[backend/api/channels.py](backend/api/channels.py)
- Memory 配置与记忆文件预览：[backend/api/memory.py](backend/api/memory.py)

### 数据面板

- Profile 统计聚合与入库：[backend/services/profile_stats_service.py](backend/services/profile_stats_service.py)
- 主机信息采集：[backend/services/host_info_service.py](backend/services/host_info_service.py)
- Hermes / 组件版本信息汇总（面板与多 profile 维度）：[backend/services/hermes_info_service.py](backend/services/hermes_info_service.py)
- Token 用量聚合（读取 Hermes `state.db`）：[backend/services/state_reader.py](backend/services/state_reader.py)
- Dashboard 后端接口：[backend/api/profile_stats.py](backend/api/profile_stats.py) (`/profiles/aggregated`)、[backend/api/host_info.py](backend/api/host_info.py) (`/host-info`)、[backend/api/tokens.py](backend/api/tokens.py) (`/tokens`)
- Dashboard 前端：[frontend/src/pages/Dashboard.tsx](frontend/src/pages/Dashboard.tsx)
- Profiles 聚合页（多主机 profile 统计 + 主机元数据）：[frontend/src/pages/ProfileStats.tsx](frontend/src/pages/ProfileStats.tsx)

### Gateway

- 状态查询与启动/停止/重启：[backend/api/gateway.py](backend/api/gateway.py)、[backend/services/gateway_service.py](backend/services/gateway_service.py)
- 仅允许 `gateway: status/start/stop/restart` 白名单命令

### 系统与升级

- 系统指标采集（psutil）：[backend/services/system_monitor.py](backend/services/system_monitor.py)
- 历史指标查询与 WebSocket 实时推送：[backend/api/system.py](backend/api/system.py)（含公开的 `/system/health` 健康检查）
- Hermes 版本检查与在线升级：[backend/services/hermes_update_service.py](backend/services/hermes_update_service.py)、依赖 `HermesInfoService` 提供版本数据

### 审计日志

- 操作审计写入与查询：[backend/api/audit.py](backend/api/audit.py)（路由前缀 `/audit-logs`）
- 审计日志服务：[backend/services/audit_log.py](backend/services/audit_log.py)

## 数据同步机制

Hermes Panel 支持多实例之间的数据同步，用于把若干"子面板"的 profile 统计和主机信息汇总到一个"主面板"。

### 同步配置

| 配置项 | 环境变量 | 说明 |
|--------|----------|------|
| 发送数据同步 | `SYNC_ENABLED` | 本机是否定时把本地数据推送到目标面板 |
| 接收数据同步 | `SYNC_RECEIVE_ENABLED` | 本机是否接收其它面板推送的数据 |
| 同步目标 | `SYNC_TARGET_URL` | 接收数据的目标面板地址，例如 `http://192.168.1.10:8650` |
| 同步 token | `SYNC_TOKEN` | 发送端把它作为 `Authorization: Bearer` 请求头发给目标面板 |
| 同步间隔 | `SYNC_INTERVAL` | 默认 60 秒 |

> 注意：当前接收端 `POST /api/v1/sync/` 要求 **admin JWT** 鉴权，并不会在服务端校验 `SYNC_TOKEN`。`SYNC_TOKEN` 仅用于发送端构造请求头；如需让子面板无交互推送，需在目标面板持有有效的 admin token，或后续扩展接收端鉴权策略。

### 数据流向

```
子面板                          主面板
  │                               │
  ├─ ProfileStatsService.collect_local_stats() ─┐
  ├─ HostInfoService.refresh_local() ───────────┤
  │                               │             │
  │                               │  定时 60s   │
  │                               ▼             │
  │                    SyncService.push()       │
  │                               │             │
  │                               │ POST /api/v1/sync/（admin JWT）
  │                               │             │
  │                               ▼             │
  │                    SyncService.ingest() ◄───┘
  │                               │
  │                               ▼
  │                    profiles 表
  │
  ▼
本地 profiles 表
```

### 后台任务

FastAPI lifespan 启动两个后台任务（见 [`backend/main.py`](backend/main.py)）：

1. `_refresh_local_data`：每 60 秒扫描本地 Hermes profiles，把统计写入统一的 `profiles` 表，随后用本机主机元数据（Hermes 版本、组件版本等）更新这些行。profile 统计与主机元数据写同一张表、同一批行，因此合并为单一定时循环，确保两者在同一周期内时间戳一致。
2. `_run_sync_loop`：若 `SYNC_ENABLED=true` 且配置了 `SYNC_TARGET_URL`，则每 `SYNC_INTERVAL` 秒把本地数据 POST 到目标面板

### 接收端处理

目标面板收到 `POST /api/v1/sync/` 后：

1. 校验请求携带的 admin JWT（`require_admin` 依赖）
2. 检查 `SYNC_RECEIVE_ENABLED`，未启用则返回 400
3. 调用 `SyncService.ingest()` 把 payload 中的 `profiles` 写入本地统一的 `profiles` 表，主机元数据随每个 profile 行一起更新
4. 数据按发送方的 `(host, username, ip, profile_name)` 区分，不会覆盖本机数据

相关代码：

- 同步 API：[backend/api/sync.py](backend/api/sync.py)
- 同步业务逻辑：[backend/services/sync_service.py](backend/services/sync_service.py)
- 设置页前端：[frontend/src/pages/Settings.tsx](frontend/src/pages/Settings.tsx)

### 前端展示

`profiles` 表中的数据会按 `(host, username, ip)`（即 `server_id`）分组，在左侧导航以"主机 → Profile → 配置分类"的树形展示，并在 Dashboard 汇总多主机数据。详情见：

- 聚合接口：[backend/api/profile_stats.py](backend/api/profile_stats.py) (`/profiles/aggregated`)、[backend/api/host_info.py](backend/api/host_info.py)
- 侧边栏：[frontend/src/components/AppLayout.tsx](frontend/src/components/AppLayout.tsx)

## API 概览

所有接口挂载在 `/api/v1` 前缀下。除登录、`/system/health` 健康检查和 `/system/ws/system` WebSocket 实时推送外，均需 `Authorization: Bearer <token>`；admin 专属接口还需 admin 角色。

| 前缀 | 说明 |
|------|------|
| `/auth` | 登录、当前用户、登出 |
| `/users` | 用户增删改查、改密码（admin） |
| `/config` | config.yaml section / 原始 YAML 读写 |
| `/profile-files` | profile 下 config / .env / SOUL / USER / MEMORY 文件（.env 掩码） |
| `/profiles` | profile 列表与详情 |
| `/profiles/aggregated` | profile 统计聚合（含多主机） |
| `/skills` | skills 列表、读写、启用禁用、导入、external-dirs |
| `/plugins` | 插件列表、启用、禁用、删除 |
| `/models` | 模型 section、providers、预设、连通性测试 |
| `/channels` | 渠道配置（config + .env） |
| `/memory` | memory 配置与记忆文件预览 |
| `/tokens` | token 用量聚合、趋势、仪表盘 |
| `/host-info` | 主机信息聚合 |
| `/system` | 系统指标、历史、版本、Hermes 更新（admin），`/ws/system` 实时推送，`/health` 公开端点 |
| `/gateway` | 网关状态与启停控制 |
| `/sync` | 数据同步配置与接收端点 |
| `/audit-logs` | 审计日志 |

## 前端技术栈

- **框架**：React 18 + TypeScript
- **构建工具**：Vite 5
- **样式**：Tailwind CSS v4 + PostCSS + Autoprefixer
- **组件库**：shadcn/ui（基于 Radix UI）、Ant Design
- **状态管理**：Zustand
- **路由**：React Router v6
- **HTTP 客户端**：Axios
- **图表**：ECharts + echarts-for-react
- **动画**：Framer Motion
- **日期处理**：dayjs
- **Markdown 渲染**：react-markdown
- **图标**：lucide-react、@ant-design/icons
- **中文字体**：@chinese-fonts/maple-mono-cn、@chinese-fonts/mksjh

## 项目结构

```
hermes-panel/
├── backend/
│   ├── api/               # FastAPI 路由（按资源拆分）
│   │   ├── audit.py       # 审计日志
│   │   ├── auth.py        # 认证
│   │   ├── channels.py    # 渠道
│   │   ├── config.py      # 配置管理
│   │   ├── gateway.py     # Gateway 控制
│   │   ├── host_info.py   # 主机信息
│   │   ├── memory.py      # 记忆配置
│   │   ├── models_config.py # 模型配置
│   │   ├── plugins.py     # 插件管理
│   │   ├── profile_files.py # Profile 文件
│   │   ├── profile_stats.py # Profile 统计
│   │   ├── profiles.py    # Profile 列表
│   │   ├── skills.py      # Skills 管理
│   │   ├── sync.py        # 数据同步
│   │   ├── system.py      # 系统指标与 WebSocket
│   │   ├── tokens.py      # Token 用量
│   │   └── users.py       # 用户管理
│   ├── auth/              # JWT 认证与依赖
│   │   ├── dependencies.py
│   │   ├── models.py
│   │   └── service.py
│   ├── db/                # 数据库连接、schema、模型
│   │   ├── database.py
│   │   └── models.py
│   ├── services/          # 业务逻辑
│   │   ├── atomic_io.py
│   │   ├── audit_log.py
│   │   ├── cli_runner.py
│   │   ├── env_service.py
│   │   ├── gateway_service.py
│   │   ├── hermes_info_service.py
│   │   ├── hermes_update_service.py
│   │   ├── host_info_service.py
│   │   ├── profile_service.py
│   │   ├── profile_stats_service.py
│   │   ├── skill_service.py
│   │   ├── state_reader.py
│   │   ├── subprocess_utils.py
│   │   ├── sync_service.py
│   │   ├── system_monitor.py
│   │   └── yaml_service.py
│   ├── tests/             # pytest 后端测试
│   │   ├── test_api.py
│   │   ├── test_services.py
│   │   └── test_spa.py
│   ├── config.py          # 配置加载与环境变量管理
│   └── main.py            # FastAPI 入口、静态文件 serve、后台任务
├── frontend/
│   └── src/
│       ├── pages/         # 页面组件
│       │   ├── Dashboard.tsx
│       │   ├── ProfileStats.tsx
│       │   ├── ProfileConfig.tsx
│       │   ├── SkillsManager.tsx
│       │   ├── PluginsManager.tsx
│       │   ├── ModelsConfig.tsx
│       │   ├── ChannelsConfig.tsx
│       │   ├── MemoryConfig.tsx
│       │   ├── TokenUsage.tsx
│       │   ├── Settings.tsx
│       │   ├── Login.tsx
│       │   └── SectionPage.tsx
│       ├── components/    # 通用组件与布局
│       │   ├── AppLayout.tsx
│       │   ├── ChannelFormModal.tsx
│       │   ├── ConfirmDialog.tsx
│       │   ├── EmptyState.tsx
│       │   ├── ErrorAlert.tsx
│       │   ├── ErrorBoundary.tsx
│       │   ├── JsonEditor.tsx
│       │   ├── Loading.tsx
│       │   ├── PageContainer.tsx
│       │   ├── PageHeader.tsx
│       │   ├── ProviderEditModal.tsx
│       │   └── ui/        # shadcn/ui 组件
│       ├── store/         # Zustand 状态管理
│       │   ├── authStore.ts
│       │   └── configStore.ts
│       ├── hooks/         # 通用 hooks
│       │   ├── useApi.ts
│       │   └── use-toast.ts
│       ├── api/           # Axios API 客户端
│       │   └── client.ts
│       ├── config/        # 渠道等前端配置定义
│       │   ├── channelDefs.ts
│       │   └── profileCategories.ts
│       ├── lib/           # 通用库工具（如 cn 等工具函数）
│       │   └── utils.ts
│       ├── utils/         # 格式化等辅助函数
│       │   └── format.ts
│       ├── types.ts       # TypeScript 类型定义
│       ├── App.tsx        # 路由与顶层布局
│       ├── main.tsx       # 入口
│       ├── index.css      # 全局样式
│       └── styles.css     # 额外样式
├── Makefile               # 统一命令入口
├── pyproject.toml         # Python 依赖与工具配置
├── .env.example           # 配置模板
└── README.md              # 项目说明
```

## License

MIT
