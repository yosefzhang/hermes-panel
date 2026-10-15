"""测试环境：把面板数据目录重定向到 tests 目录下，避免触碰真实 /data。"""

import os
from pathlib import Path

# 与 pyproject.toml 的约定一致，测试产生的临时数据都限定在 backend/tests 内。
_TEST_DATA_DIR = Path(__file__).resolve().parent / ".test_data"
_TEST_DATA_DIR.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("HERMES_PANEL_DATA_DIR", str(_TEST_DATA_DIR))
# config.yaml 位于数据目录（HERMES_PANEL_DATA_DIR）下。把 cwd 切到测试数据目录
# 是为了 --basetemp=backend/tests/.pytest_tmp 相对 cwd 解析，避免污染项目根；
# chdir 后其父目录需预先创建。
os.chdir(_TEST_DATA_DIR)
(_TEST_DATA_DIR / "backend" / "tests").mkdir(parents=True, exist_ok=True)