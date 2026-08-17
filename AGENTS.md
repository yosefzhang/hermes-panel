# AGENTS.md

## 项目定位

Hermes Panel 是 Hermes Agent 的 Web 管理面板。它提供登录鉴权、Profile 管理、配置编辑、模型与渠道配置、Skills/Plugins 管理、Gateway 控制、Token 用量、主机版本信息和跨 Panel 数据同步。

## 技术栈

- 后端：Python 3.11+、FastAPI、Uvicorn、Pydantic Settings、SQLite、`ruamel.yaml`
- 前端：React 18、TypeScript、Vite、Tailwind CSS v4、Zustand、ECharts、Ant Design、Radix/shadcn UI
- 数据源：当前用户的 Hermes 数据目录，默认 `~/.hermes`
- 后端数据库：默认 `~/.config/hermes-panel/hermes-panel.db`
- CLI 集成：通过本机 `hermes` 可执行文件执行 Gateway、Memory、Skills、Plugins 和配置版本检查

## 目录结构

- `backend/main.py`：FastAPI 应用、生命周期、静态文件服务和后台采集任务
- `backend/api/`：按功能拆分的 API 路由
- `backend/services/`：Hermes CLI、Profile、统计、同步和配置等业务逻辑
- `backend/db/`：SQLite schema、迁移和数据模型
- `backend/tests/`：后端测试
- `frontend/src/App.tsx`：前端路由和认证入口
- `frontend/src/pages/`：页面级功能
- `frontend/src/components/`：共享 UI 组件
- `frontend/src/api/client.ts`：前端 API 客户端和请求缓存
- `scripts/push_sync.py`：无需安装 Panel 的独立同步推送脚本
- `config.yaml.example`：Panel 配置示例
- `Makefile`：开发、构建、测试、生产启动和停止命令

## 开发命令

```bash
make install          # 创建 .venv、安装后端和前端依赖
make dev              # 后端 8650 + Vite 前端 5173，带热重载
make dev-backend     # 只启动后端
make dev-frontend     # 只启动前端
make build            # 确保前端依赖后构建 frontend/dist
make prod             # 构建并用配置端口启动生产服务，默认 8090
make test             # pytest backend/tests
make lint             # Ruff + TypeScript 检查
make clean            # 清理构建缓存
make stop             # 停止开发和生产端口上的服务
```

运行前提：Python 3.11+、Node.js 18+、npm，以及可执行的 `hermes` CLI。

## 配置规则

配置文件固定为 `~/.config/hermes-panel/config.yaml`，不存在时由 `config.yaml.example` 自动生成。Panel 配置只从 YAML 读取，不提供环境变量覆盖，也不兼容旧配置格式。

常用配置：

```yaml
hermes_path: ~/.hermes
db_path: ~/.config/hermes-panel/hermes-panel.db
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

`sync.send.endpoints` 支持多个目标，每个目标独立使用自己的 Token。接收端使用 `sync.receive.token` 校验 `Authorization: Bearer`。同步配置由设置页保存，保存后会立即尝试推送一次。

## 数据和后台任务

- Hermes 文件和 CLI 操作使用 `hermes_path` 指向的数据目录，不要把面板数据库写入 Hermes 的 state 数据库。
- Panel 自有数据写入 SQLite 的 `host_info` 和 `profile_info` 等表。
- 服务启动时执行一次完整本机采集。
- Profile 快速统计默认每 10 分钟更新，完整统计和主机版本信息默认每 1 小时更新。
- 超过 24 小时未更新的主机/Profile 记录会自动清理。
- 不要在请求处理器中绕过已有 service 直接修改 SQLite，优先复用对应 service。

## 修改约定

- 先阅读相邻 service、API 路由和页面，再做局部修改。
- 保持 API 字段和配置命名一致；同步配置必须区分 `send` 与 `receive`。
- 版本查询失败时保留已配置组件的字段，使用 `null` 表示未知，不要静默删除列。
- HTTPS 同步请求必须保留证书校验，不要使用 `verify=False` 或跳过 CA 验证。
- 前端页面使用已有的组件、`useApi` 和 API client；不要重复创建请求缓存或布局。
- 不要提交 `.venv/`、`frontend/dist/`、缓存、凭据、Token 或本地配置文件。
- 未明确要求时不要提交 `.agents/`、`.trae/` 等工作区辅助目录。

## 验证要求

改动后至少运行与改动直接相关的检查：

```bash
.venv/bin/python -m py_compile <changed-python-files>
cd frontend && npx tsc --noEmit
pytest backend/tests -q
```

如果涉及前端生产产物，再运行：

```bash
make build
```

全量测试出现既有失败时，记录失败用例和是否与本次改动相关，不要为了让测试全绿而修改无关业务。
