from pathlib import Path

from fastapi.testclient import TestClient

from backend.config import Settings, _build_settings_from_file
from backend.main import create_app


def make_client(tmp_path: Path) -> TestClient:
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    (hermes_home / "memories").mkdir()
    (hermes_home / "config.yaml").write_text("model:\n  api_key: sk-secret-value\n", encoding="utf-8")
    (hermes_home / ".env").write_text("API_KEY=sk-env-secret\nNORMAL=value\n", encoding="utf-8")
    (hermes_home / "SOUL.md").write_text("# soul\n", encoding="utf-8")
    (hermes_home / "memories" / "USER.md").write_text("# user\n", encoding="utf-8")
    (hermes_home / "memories" / "MEMORY.md").write_text("# memory\n", encoding="utf-8")
    settings = Settings(
        hermes_home=hermes_home,
        data_dir=tmp_path / "data",
        log_file_path=tmp_path / "hermes-panel.log",
        default_admin_password="admin-test-password",
        jwt_secret="test-secret-for-hermes-panel-tests-min-32-bytes",
    )
    app = create_app(settings)
    return TestClient(app)


def login(client: TestClient) -> str:
    response = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "admin-test-password"},
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def test_default_admin_can_login_and_read_config(tmp_path: Path):
    client = make_client(tmp_path)
    token = login(client)

    response = client.get("/api/v1/config?profile=default", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert response.json()["model"]["api_key"] == "sk-secret-value"


def test_env_overrides_default_admin_credentials(monkeypatch):
    """HERMES_PANEL_ADMIN_USERNAME/PASSWORD 环境变量优先于 YAML 与默认值。"""
    monkeypatch.setenv("HERMES_PANEL_ADMIN_USERNAME", "root")
    monkeypatch.setenv("HERMES_PANEL_ADMIN_PASSWORD", "env-secret")

    settings = _build_settings_from_file({})

    assert settings.default_admin_username == "root"
    assert settings.default_admin_password == "env-secret"


def test_yaml_admin_credentials_used_when_env_absent(monkeypatch):
    """环境变量未设置时回退到 config.yaml 中的值。"""
    monkeypatch.delenv("HERMES_PANEL_ADMIN_USERNAME", raising=False)
    monkeypatch.delenv("HERMES_PANEL_ADMIN_PASSWORD", raising=False)

    settings = _build_settings_from_file(
        {"default_admin_username": "ops", "default_admin_password": "yaml-secret"}
    )

    assert settings.default_admin_username == "ops"
    assert settings.default_admin_password == "yaml-secret"


def test_custom_admin_credentials_seed_admin_user(tmp_path: Path):
    """首次播种使用 settings 中的自定义用户名/密码，而非默认 admin/admin。"""
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    settings = Settings(
        hermes_home=hermes_home,
        data_dir=tmp_path / "data",
        log_file_path=tmp_path / "hermes-panel.log",
        default_admin_username="root",
        default_admin_password="custom-secret",
        jwt_secret="test-secret-for-hermes-panel-tests-min-32-bytes",
    )
    client = TestClient(create_app(settings))

    ok = client.post("/api/v1/auth/login", json={"username": "root", "password": "custom-secret"})
    fallback = client.post("/api/v1/auth/login", json={"username": "admin", "password": "admin"})

    assert ok.status_code == 200
    assert fallback.status_code == 401


def test_sync_status_uses_forwarded_https_url(tmp_path: Path):
    client = make_client(tmp_path)
    token = login(client)

    response = client.get(
        "/api/v1/sync/status",
        headers={
            "Authorization": f"Bearer {token}",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "panel.example.com",
        },
    )

    assert response.status_code == 200
    assert response.json()["receive_url"] == "https://panel.example.com/api/v1/sync/"


def test_sync_status_uses_browser_https_url_without_forwarded_headers(tmp_path: Path):
    client = make_client(tmp_path)
    token = login(client)

    response = client.get(
        "/api/v1/sync/status",
        headers={
            "Authorization": f"Bearer {token}",
            "Referer": "https://panel.example.com/settings",
        },
    )

    assert response.status_code == 200
    assert response.json()["receive_url"] == "https://panel.example.com/api/v1/sync/"


def test_profile_files_return_basic_configuration_files(tmp_path: Path):
    client = make_client(tmp_path)
    token = login(client)

    response = client.get(
        "/api/v1/profile-files?profile=default",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    files = {item["name"]: item for item in response.json()["files"]}
    assert set(files) == {".env", "config.yaml", "SOUL.md", "USER.md", "MEMORY.md"}
    assert files[".env"]["content"] == "API_KEY=sk-***ret\nNORMAL=value\n"
    assert files["SOUL.md"]["content"] == "# soul\n"


def test_non_admin_user_is_limited_to_assigned_profiles(tmp_path: Path):
    client = make_client(tmp_path)
    token = login(client)

    create_response = client.post(
        "/api/v1/users",
        json={"username": "alice", "password": "secret", "role": "user", "profiles": ["xiaokui"]},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert create_response.status_code == 201

    alice_login = client.post("/api/v1/auth/login", json={"username": "alice", "password": "secret"})
    alice_token = alice_login.json()["access_token"]

    denied = client.get(
        "/api/v1/config?profile=default",
        headers={"Authorization": f"Bearer {alice_token}"},
    )
    assert denied.status_code == 403


def test_admin_can_rename_user(tmp_path: Path):
    """admin 通过 PUT /users/{id} 修改用户名，修改后用新用户名可登录。"""
    client = make_client(tmp_path)
    token = login(client)

    create_response = client.post(
        "/api/v1/users",
        json={"username": "alice", "password": "secret", "role": "user", "profiles": ["default"]},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert create_response.status_code == 201
    user_id = create_response.json()["id"]

    update = client.put(
        f"/api/v1/users/{user_id}",
        json={"username": "alice2"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert update.status_code == 200
    assert update.json()["username"] == "alice2"

    new_login = client.post("/api/v1/auth/login", json={"username": "alice2", "password": "secret"})
    assert new_login.status_code == 200
    old_login = client.post("/api/v1/auth/login", json={"username": "alice", "password": "secret"})
    assert old_login.status_code == 401


def test_rename_to_existing_username_conflicts(tmp_path: Path):
    client = make_client(tmp_path)
    token = login(client)

    create = client.post(
        "/api/v1/users",
        json={"username": "alice", "password": "secret", "role": "user", "profiles": ["default"]},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert create.status_code == 201
    user_id = create.json()["id"]

    conflict = client.put(
        f"/api/v1/users/{user_id}",
        json={"username": "admin"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert conflict.status_code == 409


def test_non_admin_cannot_change_password_or_username(tmp_path: Path):
    """仅 admin 可修改用户名/密码；普通用户改自己的密码也返回 403。"""
    client = make_client(tmp_path)
    token = login(client)

    create = client.post(
        "/api/v1/users",
        json={"username": "alice", "password": "secret", "role": "user", "profiles": ["default"]},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert create.status_code == 201
    user_id = create.json()["id"]

    alice_login = client.post("/api/v1/auth/login", json={"username": "alice", "password": "secret"})
    alice_token = alice_login.json()["access_token"]

    change_password = client.put(
        f"/api/v1/users/{user_id}/password",
        json={"new_password": "new-secret"},
        headers={"Authorization": f"Bearer {alice_token}"},
    )
    assert change_password.status_code == 403

    rename = client.put(
        f"/api/v1/users/{user_id}",
        json={"username": "alice2"},
        headers={"Authorization": f"Bearer {alice_token}"},
    )
    assert rename.status_code == 403


def test_update_provider_writes_key_to_env_and_preserves_models(tmp_path: Path):
    client = make_client(tmp_path)
    token = login(client)
    hermes = tmp_path / ".hermes"
    (hermes / "config.yaml").write_text(
        "custom_providers:\n"
        "  - name: deepseek\n"
        "    base_url: https://api.deepseek.com\n"
        "    key_env: DEEPSEEK_API_KEY\n"
        "    models:\n"
        "      - deepseek-chat\n",
        encoding="utf-8",
    )
    (hermes / ".env").write_text("DEEPSEEK_API_KEY=sk-old\n", encoding="utf-8")

    response = client.put(
        "/api/v1/models/providers/deepseek",
        json={
            "name": "deepseek",
            "base_url": "https://api.deepseek.com",
            "key_env": "DEEPSEEK_API_KEY",
            "api_key": "sk-new-secret",
        },
        params={"profile": "default"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    # 密钥应写入 .env 中 key_env 指向的变量，而不是 config.yaml 的 inline api_key
    assert (hermes / ".env").read_text(encoding="utf-8") == "DEEPSEEK_API_KEY=sk-new-secret\n"

    from backend.services.profile import YamlService

    providers = YamlService(hermes).read_section("default", "custom_providers")
    assert providers[0]["models"] == ["deepseek-chat"]
    assert "api_key" not in providers[0]


def test_update_channel_env_writes_env_file(tmp_path: Path):
    client = make_client(tmp_path)
    token = login(client)
    hermes = tmp_path / ".hermes"
    (hermes / ".env").write_text("FEISHU_APP_ID=cli-old\n", encoding="utf-8")

    response = client.put(
        "/api/v1/channels/feishu/env",
        json={"FEISHU_APP_ID": "cli-new", "FEISHU_APP_SECRET": "secret"},
        params={"profile": "default"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    assert (hermes / ".env").read_text(encoding="utf-8") == "FEISHU_APP_ID=cli-new\nFEISHU_APP_SECRET=secret\n"


def test_update_channel_writes_credentials_to_env_not_config(tmp_path: Path):
    """渠道凭据（token）必须写入 .env，其余字段保留在 config.yaml。

    修复前 `PUT /channels/{name}` 会把 token 一并写进 config.yaml，
    而 Hermes 实际从 .env 的 TELEGRAM_BOT_TOKEN 读取，导致编辑不生效。
    """
    client = make_client(tmp_path)
    token = login(client)
    hermes = tmp_path / ".hermes"
    (hermes / ".env").write_text("", encoding="utf-8")

    response = client.put(
        "/api/v1/channels/telegram",
        json={
            "token": "123456:ABC-DEF1234gh",
            "allowed_chats": "123,456",
            "enabled": True,
        },
        params={"profile": "default"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    # 凭据写入 .env
    assert (hermes / ".env").read_text(encoding="utf-8") == "TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234gh\n"

    from backend.services.profile import YamlService

    config = YamlService(hermes).read_config("default")
    # 非凭据字段写入 config.yaml，凭据字段不残留
    assert config.get("telegram", {}).get("token") is None
    assert config["telegram"]["allowed_chats"] == "123,456"
    assert config["telegram"]["enabled"] is True


def test_update_channel_feishu_writes_multiple_credentials_to_env(tmp_path: Path):
    """飞书渠道多个凭据字段都应写入 .env，并与非凭据字段分离。"""
    client = make_client(tmp_path)
    token = login(client)
    hermes = tmp_path / ".hermes"
    (hermes / ".env").write_text("", encoding="utf-8")

    response = client.put(
        "/api/v1/channels/feishu",
        json={
            "app_id": "cli_abc",
            "app_secret": "secret-123",
            "encrypt_key": "enc-456",
        },
        params={"profile": "default"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    env_content = (hermes / ".env").read_text(encoding="utf-8")
    assert "FEISHU_APP_ID=cli_abc\n" in env_content
    assert "FEISHU_APP_SECRET=secret-123\n" in env_content
    assert "FEISHU_ENCRYPT_KEY=enc-456\n" in env_content

    from backend.services.profile import YamlService

    config = YamlService(hermes).read_config("default")
    feishu = config.get("feishu", {})
    assert feishu.get("app_id") is None
    assert feishu.get("app_secret") is None


def test_create_provider_custom_writes_key_to_env(tmp_path: Path):
    """新增自定义 supplier 时密钥也应写入 .env，而非仅写 config.yaml。"""
    client = make_client(tmp_path)
    token = login(client)
    hermes = tmp_path / ".hermes"
    (hermes / ".env").write_text("", encoding="utf-8")

    response = client.post(
        "/api/v1/models/providers",
        json={
            "mode": "custom",
            "name": "my-gateway",
            "key_env_var": "MY_GATEWAY_API_KEY",
            "key_value": "sk-abc",
            "base_url": "https://api.example.com",
        },
        params={"profile": "default"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 201
    assert (hermes / ".env").read_text(encoding="utf-8") == "MY_GATEWAY_API_KEY=sk-abc\n"

    from backend.services.profile import YamlService

    providers = YamlService(hermes).read_section("default", "custom_providers")
    assert providers[0]["name"] == "my-gateway"
    assert providers[0]["key_env"] == "MY_GATEWAY_API_KEY"
    assert "api_key" not in providers[0]