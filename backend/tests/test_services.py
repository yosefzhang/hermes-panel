from pathlib import Path

from backend.services.env_service import EnvService
from backend.services.profile_service import ProfileService
from backend.services.yaml_service import YamlService


def test_env_service_updates_values(tmp_path: Path):
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    env_path = hermes_home / ".env"
    env_path.write_text("# keep me\nAPI_KEY=sk-original\nNORMAL=value\n", encoding="utf-8")

    service = EnvService(hermes_home)
    service.write_env("default", {"API_KEY": "sk-updated-secret", "ADDED": "yes"})

    assert env_path.read_text(encoding="utf-8") == "# keep me\nAPI_KEY=sk-updated-secret\nNORMAL=value\nADDED=yes\n"
    assert service.read_env("default") == {
        "API_KEY": "sk-updated-secret",
        "NORMAL": "value",
        "ADDED": "yes",
    }


def test_yaml_service_preserves_comments_and_writes_section(tmp_path: Path):
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    config_path = hermes_home / "config.yaml"
    config_path.write_text("# top comment\nmodel:\n  provider: deepseek\n", encoding="utf-8")

    service = YamlService(hermes_home)
    service.write_section("default", "memory", {"enabled": True})


    content = config_path.read_text(encoding="utf-8")
    assert "# top comment" in content
    assert "memory:" in content
    assert service.read_section("default", "memory") == {"enabled": True}


def test_profile_service_lists_default_and_configured_profiles(tmp_path: Path):
    hermes_home = tmp_path / ".hermes"
    (hermes_home / "profiles" / "xiaokui").mkdir(parents=True)
    (hermes_home / "profiles" / "empty").mkdir()
    (hermes_home / "config.yaml").write_text("model: {}\n", encoding="utf-8")
    (hermes_home / "profiles" / "xiaokui" / "config.yaml").write_text("model: {}\n", encoding="utf-8")

    service = ProfileService(hermes_home)

    assert service.list_profiles() == ["default", "xiaokui"]
    assert service.get_config_path("default") == hermes_home / "config.yaml"
    assert service.get_config_path("xiaokui") == hermes_home / "profiles" / "xiaokui" / "config.yaml"


