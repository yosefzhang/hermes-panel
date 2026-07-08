from pathlib import Path

from fastapi.testclient import TestClient

from backend.config import Settings
from backend.main import create_app


def test_spa_frontend_routes_fall_back_to_index(tmp_path: Path):
    settings = Settings(
        hermes_home=tmp_path / ".hermes",
        control_db_path=tmp_path / "control.db",
        default_admin_password="admin-test-password",
        jwt_secret="test-secret-for-spa-route-check",
    )
    app = create_app(settings)
    client = TestClient(app)

    response = client.get("/config")

    assert response.status_code == 200
    assert "Hermes Panel" in response.text