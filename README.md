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

首次启动会自动将 `config.yaml.example` 复制到 `~/.config/hermes-panel/config.yaml` 并据此创建默认管理员 `admin`。默认密码在 `config.yaml.example` 中为 `changeme`，若 `HERMES_PANEL_DEFAULT_ADMIN_PASSWORD` 环境变量未设置则使用该值；生产环境务必通过环境变量修改：

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

将 `config.yaml.example` 复制到 `~/.config/hermes-panel/config.yaml` 并按需修改，启动时会自动加载（可用 `HERMES_PANEL_CONFIG` 环境变量覆盖路径）。已存在的 shell 环境变量优先级高于配置文件；若该文件不存在，会自动从项目根目录的 `config.yaml.example` 拷贝生成。

```bash
mkdir -p ~/.config/hermes-panel && cp config.yaml.example ~/.config/hermes-panel/config.yaml
```

### 配置文件项（config.yaml）

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `hermes_path` | Hermes Agent 数据目录 | `~/.hermes` |
| `db_path` | Panel SQLite 数据库路径 | `~/.config/hermes-panel/hermes-panel.db` |
| `jwt_secret` | JWT 签名密钥（生产环境必须修改） | `changeme` |
| `default_admin_password` | 首次启动创建的 admin 密码 | `changeme` |
| `log_file` | 后端日志文件路径 | `~/.config/hermes-panel/hermes-panel.log` |
| `log_level` | 后端日志级别 | `INFO` |
| `component_versions` | 要查询版本号的组件列表，每项含 `name`/`command`/`args`/`regex` | hermes, node, npm, git, lark-cli, quectel-cli |
| `sync.enabled` | 是否向目标面板推送数据 | `false` |
| `sync.receive_enabled` | 是否接收其它面板推送的数据 | `false` |
| `sync.target_url` | 数据同步目标面板地址 | - |
| `sync.send_token` | 发送同步提交给目标面板的出站凭证（`Authorization: Bearer`） | - |
| `sync.receive_token` | 接收端 `/sync/` 与 `/webhook/sync` 校验的入站凭证 | - |
| `sync.token` | 兼容旧配置：单一共享 token；未分别配置 send/receive 时回退到此键 | - |
| `sync.interval` | 默认 600 秒 |

### 环境变量覆盖

以下环境变量如果设置，会覆盖配置文件中的对应项：

| 环境变量 | 覆盖的配置项 |
|----------|-------------|
| `HERMES_PATH` | `hermes_path` |
| `HERMES_PANEL_DB` | `db_path` |
| `HERMES_PANEL_JWT_SECRET` | `jwt_secret` |
| `HERMES_PANEL_DEFAULT_ADMIN_PASSWORD` | `default_admin_password` |
| `HERMES_PANEL_LOG_FILE` | `log_file` |
| `HERMES_PANEL_LOG_LEVEL` | `log_level` |
| `HERMES_PANEL_CONFIG` | 配置文件路径本身 |

配置加载与更新逻辑见 [`backend/config.py`](backend/config.py)。

## 日志

Hermes Panel 后端使用 RotatingFileHandler 将日志写入文件，同时输出到 stderr 以便在终端查看。默认日志文件位于 `~/.config/hermes-panel/hermes-panel.log`，单个文件最大 5 MB，最多保留 5 个归档文件。

可通过 `HERMES_PANEL_LOG_LEVEL` 调整日志级别（如 `DEBUG`、`INFO`、`WARNING`、`ERROR`）。

## 数据库

Hermes Panel 使用单一 SQLite 数据库文件存储所有自身数据，路径由 `HERMES_PANEL_DB` 控制，默认位于 `~/.config/hermes-panel/hermes-panel.db`。表结构定义在 [`backend/db/database.py`](backend/db/database.py) 中。数据库使用 WAL（Write-Ahead Logging）模式并设置 `busy_timeout=10s`，以支持并发读写并避免锁冲突。

数据库包含两类表：

### 1. 控制表（control）

| 表名 | 用途 | 关键字段 |
|------|------|----------|
| `users` | 登录用户与权限 | `username`, `password_hash`, `role` (`admin`/`user`), `profiles`（可访问 profile 列表，JSON 数组，`["*"]` 表示全部） |
| `system_metrics` | 系统资源历史 | `timestamp`, `cpu_percent`, `memory_percent`, `memory_used_gb`, `memory_total_gb`, `disk_percent`, `net_bytes_sent`, `net_bytes_recv`, `load_avg_1m` |
| `audit_logs` | 操作审计日志 | `timestamp`, `actor`, `action`, `target_type`, `target_id`, `details`, `success`, `ip_address` |

### 2. 数据表（host_info + profile_info）

主机级元数据与 profile 级统计分别存储在两张表中，各按不同的频率刷新，避免主机信息在每个 profile 行上反规范化复制。

#### host_info 表

每一行代表**一台主机**，由 `(host, username, ip)` 唯一标识。默认 **1 小时**刷新一次。

| 字段 | 说明 | 更新频率 |
|------|------|----------|
| `host` | 主机名 | - |
| `username` | 用户名 | - |
| `ip` | IP 地址 | - |
| `hermes_version` | Hermes CLI 版本 | 1h |
| `components` | 除 Hermes 外的各组件版本信息，JSON | 1h |
| `updated_at` | 更新时间戳 | 每次采集 |

唯一约束：`UNIQUE(host, username, ip)`。

#### profile_info 表

每一行代表**某个主机上的某个 profile**，包含 gateway 状态、token 统计、模型/provider 分布等。快速周期 **10 分钟**刷新一次，完整周期 **1 小时**刷新一次。

| 字段 | 说明 | 更新频率 |
|------|------|----------|
| `host` | 主机名 | - |
| `username` | 用户名 | - |
| `ip` | IP 地址 | - |
| `profile_name` | profile 名称 | - |
| `path` | profile 路径 | 1h |
| `gateway_status` | 该 profile 下 gateway 运行状态 | 10min |
| `session_count` | 会话数 | 10min |
| `total_tokens` | 总 token 数 | 10min |
| `total_input_tokens` | 输入 token 数 | 10min |
| `total_output_tokens` | 输出 token 数 | 10min |
| `cache_hit_rate` | 缓存命中率 | 10min |
| `model_top5` | token 用量 Top5 模型，JSON 数组 | 1h |
| `provider_top5` | token 用量 Top5 provider，JSON 数组 | 1h |
| `daily_tokens` | 最近 15 天每日 token 用量，JSON 数组 | 1h |
| `current_config_version` | 当前 profile 配置版本 | 1h |
| `latest_config_version` | 最新可用配置版本 | 1h |
| `memory_available` | 外置记忆体是否可用 | 1h |
| `memory_provider` | 记忆体 provider 名称（如 openviking） | 1h |
| `memory_endpoint` | 记忆体端点地址 | 1h |
| `memory_agent` | 记忆体 agent 标识 | 1h |
| `updated_at` | 更新时间戳 | 每次采集 |

唯一约束：`UNIQUE(host, username, ip, profile_name)`。

视图层（`ProfileStatsService.get_aggregated`）在聚合时会按 `(host, username, ip)` 将 `host_info` 的主机元数据 join 回每个 server 的摘要中，前端无需感知拆表。

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
- 写入前校验与自动备份：[backend/services/yaml_service.py](backend/services/yaml_service.py)、[backend/services/cli_utils.py](backend/services/cli_utils.py)（原子写入）

### Skills 与 Plugins

- Skills 列表、来源判定、启用/禁用：[backend/api/skills.py](backend/api/skills.py)、[backend/services/skill_service.py](backend/services/skill_service.py)
- Plugins 列表、启用、禁用、删除：[backend/api/plugins.py](backend/api/plugins.py)
- 调用 Hermes CLI 时的 profile 前缀定位：[backend/services/cli_utils.py](backend/services/cli_utils.py)
- 统一的子进程执行封装：[backend/services/cli_utils.py](backend/services/cli_utils.py)（所有 subprocess 调用均记录 cmd / rc / stdout/stderr 长度到日志）

### 模型、渠道、Memory、SOUL

- 模型配置与 provider 管理：[backend/api/models_config.py](backend/api/models_config.py)
- 消息渠道配置（config + .env）：[backend/api/channels.py](backend/api/channels.py)
- Memory 文件预览与编辑（MEMORY.md / USER.md）：[backend/api/memory.py](backend/api/memory.py)
- 外置记忆体状态采集（hermes memory status）：[backend/services/profile_stats_service.py](backend/services/profile_stats_service.py) `_collect_memory_status()`
- SOUL.md 查看与编辑：[backend/api/profile_files.py](backend/api/profile_files.py)（支持 SOUL.md / soul.md 大小写自动识别）

### 数据面板

- Profile 统计聚合与入库：[backend/services/profile_stats_service.py](backend/services/profile_stats_service.py)
- 主机信息采集：[backend/services/host_info_service.py](backend/services/host_info_service.py)
- Hermes / 组件版本信息汇总（面板与多 profile 维度）：[backend/services/hermes_info_service.py](backend/services/hermes_info_service.py)
- Token 用量聚合（读取 Hermes `state.db`）：[backend/services/state_reader.py](backend/services/state_reader.py)
- Dashboard 后端接口：[backend/api/profile_stats.py](backend/api/profile_stats.py) (`/profiles/aggregated`)、[backend/api/tokens.py](backend/api/tokens.py) (`/tokens`)
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

- 操作审计写入与查询：[backend/api/system.py](backend/api/system.py)（`audit_router`，路由前缀 `/audit-logs`）
- 审计日志服务：[backend/services/audit_log.py](backend/services/audit_log.py)

## 数据同步机制

Hermes Panel 支持多实例之间的数据同步，用于把若干"子面板"的 profile 统计和主机信息汇总到一个"主面板"。

### 同步配置

同步配置通过 `config.yaml` 的 `sync` 段管理，也可在前端设置页编辑（自动写回 `config.yaml`）。

| 配置项 | 说明 |
|--------|------|
| `sync.enabled` | 本机是否定时把本地数据推送到目标面板 |
| `sync.receive_enabled` | 本机是否接收其它面板推送的数据 |
| `sync.target_url` | 接收数据的目标面板地址，例如 `http://192.168.1.10:8650` |
| `sync.send_token` | 发送同步提交给目标面板的出站凭证（`Authorization: Bearer`） |
| `sync.receive_token` | 接收端 `/sync/` 与 `/webhook/sync` 校验的入站凭证 |
| `sync.token` | 兼容旧配置：单一共享 token；未分别配置 send/receive 时回退到此键 |
| `sync.interval` | 默认 600 秒 |

> 接收端 `POST /api/v1/sync/`（panel 间）与 `POST /api/v1/webhook/sync`（外部系统）均校验请求头中的 `Authorization: Bearer <token>`，token 需与接收端配置的 `sync.receive_token` 一致。发送方向目标面板推送时使用 `sync.send_token` 作为出站凭证。

### 数据流向

```
子面板                              主面板
  │                                   │
  ├─ collect_fast_stats()  10min ──┐   (gateway + token, 写 profile_info)
  ├─ collect_local_stats()  1h   ──┤   (全量 + memory, 写 profile_info)
  ├─ host_info.refresh_local() 1h ─┤   (hermes version + components, 写 host_info)
  │                                   │             │
  │                                   │  定时 SYNC_INTERVAL  │
  │                                   ▼             │
  │                        SyncService.push()       │
  │                                   │             │
  │                                   │ POST /api/v1/sync/（Bearer send_token）
  │                                   │             │
  │                                   ▼             │
  │                        SyncService.ingest() ◄───┘
  │                                   │
  │                                   ▼
  │                        host_info + profile_info 表
  │
  │  外部系统（CI / 监控 Agent / 第三方工具）
  │                                   │
  │                                   │ POST /api/v1/webhook/sync（Bearer receive_token）
  │                                   ▼
  │                        SyncService.ingest() ◄───┘
  │                                   │
  ▼                                   ▼
本地 host_info + profile_info 表
```

### 后台任务

FastAPI lifespan 启动两个后台任务（见 [`backend/main.py`](backend/main.py)）：

1. `_refresh_local_data`：双频率采集循环，将本地 Hermes 数据写入拆分的两张表：
   - **快速周期（10 分钟）**：仅采集 gateway 状态、token 总量（session_count、total_tokens、input/output_tokens、cache_hit_rate），调用 `collect_fast_stats()` 写入 `profile_info` 表
   - **完整周期（1 小时）**：采集全部字段（含 model/provider top5、daily_tokens、config version、memory status），调用 `collect_local_stats()` 写入 `profile_info` 表；同时调用 `host_info_service.refresh_local()` 写入 `host_info` 表（主机元数据仅在完整周期刷新）
   - 启动时先执行一次完整采集，确保首次渲染有完整数据
   - 两个周期共用 `_collect_lock` 防止并发写入导致 `database is locked`
   - SQLite 使用 WAL 模式 + busy_timeout=10s 防止读写锁冲突
2. `_run_sync_loop`：若 `sync.enabled=true` 且配置了 `sync.target_url`，则每 `sync.interval` 秒把本地 `host_info` + `profile_info` 数据 POST 到目标面板

> 前端"刷新"按钮（`POST /api/v1/profiles/aggregated/refresh`）会触发一次完整采集（含 host_info 刷新），不受后台定时周期限制。

### 接收端处理

目标面板收到 `POST /api/v1/sync/`（panel 间）或 `POST /api/v1/webhook/sync`（外部系统）后：

1. 校验请求头 `Authorization: Bearer <token>` 中的 token 与接收端 `sync.receive_token` 一致
2. 检查 `sync.receive_enabled`，未启用则返回 400
3. 调用 `SyncService.ingest()`：将 payload 中的 `hosts` 写入本地 `host_info` 表，`profiles` 写入本地 `profile_info` 表（按 `(host, username, ip, profile_name)` 区分，不会覆盖本机数据）

相关代码：
````
<userPrompt>
Provide the fully rewritten file, incorporating the suggested code change. You must produce the complete file.
</userPrompt>
```
