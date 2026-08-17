# Hermes Panel

Hermes Panel 是 Hermes Agent 的 Web 管理面板，用于集中查看和管理 Hermes 的配置、Profiles、模型、渠道、Skills、Plugins、Gateway、Token 用量和主机状态。它运行在 Hermes Agent 所在机器上，通过本机 `hermes` CLI 和数据目录提供管理能力，也支持多个 Panel 之间同步统计数据。

## 快速开始

### 安装

```bash
git clone https://github.com/yosefzhang/hermes-panel.git
cd hermes-panel
cp config.yaml.example ~/.config/hermes-panel/config.yaml

# 按需修改配置。配置文件不存在时，会从 `config.yaml.example` 自动生成。

make install
```
### 生产运行

> 生产环境请记得在`config.yaml`修改密码和 JWT 密钥。

```bash
make prod
```

`make prod` 会先构建前端，再根据配置中的 `port` 启动后端并提供前端静态文件。默认地址是：`http://0.0.0.0:8090`

### 开发环境

```bash
make dev
```

开发模式会启动：

- 前端：`http://127.0.0.1:5173`，Vite HMR
- 后端：`http://127.0.0.1:8650`，FastAPI/Uvicorn 热重载

首次启动会自动创建配置文件和默认管理员。默认配置中的管理员用户名：`admin`，密码是：`changeme`

## 项目结构

- `backend/`：FastAPI 后端、SQLite 数据库和 Hermes CLI 服务
- `frontend/`：React + TypeScript + Vite 前端
- `scripts/push_sync.py`：独立的数据同步推送脚本
- `config.yaml.example`：Panel 配置示例
- `AGENTS.md`：面向编程 Agent 的项目结构、命令和修改约定

## 前置要求

- Python 3.11+
- Node.js 18+ 和 npm
- 已安装且可以在当前用户环境中执行的 `hermes` CLI

`make install` 会创建 Python 虚拟环境、安装后端依赖和前端依赖。

## 配置

默认配置文件：`~/.config/hermes-panel/config.yaml`

配置文件不存在时，会从 `config.yaml.example` 自动生成。所有 Panel 配置均从该 YAML 文件读取。

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
        token: replace-with-receive-token
    interval: 600
  receive:
    enabled: false
    token: replace-with-receive-token
```

### 数据同步

发送端支持多个目标，每个目标有独立端点和 Token：

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

接收到的数据保存在 Panel 自己的 SQLite 数据库中，默认是 `~/.config/hermes-panel/hermes-panel.db`，不会写入 Hermes Agent 的 `state.db`。超过 24 小时未更新的主机和 Profile 统计会自动清理。

如果只需要从其他机器推送数据，可以使用独立脚本：

```bash
python3 scripts/push_sync.py \
  --url https://panel.example.com/api/v1/sync/ \
  --token <receive-token>
```

脚本也支持 JSON 配置、Hermes 数据目录、Hermes 可执行文件、Profile 选择和组件版本查询配置：

```bash
python3 scripts/push_sync.py --config ./push_sync.json
```



## 常用命令

```bash
make install          # 安装后端和前端依赖
make dev              # 开发模式
make build            # 构建前端生产产物
make prod             # 构建并启动生产服务
make test             # 运行后端测试
make lint             # Ruff 和 TypeScript 检查
make clean            # 清理构建缓存
make stop             # 停止 Panel 进程
```

> 更多面向编程 Agent 的代码结构、服务边界和修改约定见 [AGENTS.md](AGENTS.md)。
