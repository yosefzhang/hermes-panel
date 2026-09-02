"""测试环境：把面板数据目录重定向到 tests 目录下，避免触碰真实 /data。"""

import os
from pathlib import Path

# 与 pyproject.toml 的约定一致，测试产生的临时数据都限定在 backend/tests 内。
_TEST_DATA_DIR = Path(__file__).resolve().parent / ".test_data"
_TEST_DATA_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("HERMES_PANEL_DATA_DIR", str(_TEST_DATA_DIR))
# config.yaml 固定读取当前工作目录（./config.yaml）。把 cwd 切到测试数据目录，
# 避免导入 backend.main（模块级 create_app 会读配置并写回 sync token）时
# 污染项目根目录。
os.chdir(_TEST_DATA_DIR)
# --basetemp=backend/tests/.pytest_tmp 是相对 cwd 解析，chdir 后其父目录需预先创建。
(_TEST_DATA_DIR / "backend" / "tests").mkdir(parents=True, exist_ok=True)