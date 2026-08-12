from pathlib import Path

from fastapi.testclient import TestClient

from backend.config import Settings
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
        hermes_panel_db_path=tmp_path / "hermes-panel.db",
        default_admin_password="admin-test-password",
        jwt_secret="test-secret",
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