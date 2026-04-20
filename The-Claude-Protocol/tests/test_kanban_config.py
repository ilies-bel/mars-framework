"""Tests for the Kanban UI Dolt-connection descriptor written by bootstrap."""

import json
import os
import sys
from pathlib import Path

import pytest

SCRIPT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

import bootstrap  # noqa: E402


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    """Redirect ~ to a tmp dir so we can stub ~/.beads/dolt-server.port."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    return tmp_path


def _write_port_file(home: Path, port: int) -> None:
    beads_global = home / ".beads"
    beads_global.mkdir(exist_ok=True)
    (beads_global / "dolt-server.port").write_text(f"{port}\n")


def test_happy_path_writes_full_descriptor(fake_home, tmp_path):
    _write_port_file(fake_home, 12345)
    project = tmp_path / "proj"
    beads_dir = project / ".beads"
    beads_dir.mkdir(parents=True)
    (beads_dir / "config.yaml").write_text("database: myproj\nother: x\n")

    assert bootstrap.write_kanban_config(project, "Test Proj") is True

    cfg = json.loads((beads_dir / "kanban.json").read_text())
    assert cfg["backend"] == "dolt"
    assert cfg["host"] == "127.0.0.1"
    assert cfg["port"] == 12345
    assert cfg["user"] == "root"
    assert cfg["passwordEnv"] == "BEADS_DOLT_PASSWORD"
    assert cfg["database"] == "myproj"
    assert cfg["branch"] == "main"
    assert "generatedAt" in cfg


def test_missing_port_file_skips_write(fake_home, tmp_path, capsys):
    # No dolt-server.port stubbed.
    project = tmp_path / "proj"
    (project / ".beads").mkdir(parents=True)

    assert bootstrap.write_kanban_config(project, "proj") is False
    assert not (project / ".beads" / "kanban.json").exists()

    out = capsys.readouterr().out
    assert "dolt-server.port" in out
    assert "bd doctor" in out


def test_password_never_embedded(fake_home, tmp_path, monkeypatch):
    _write_port_file(fake_home, 5555)
    monkeypatch.setenv("BEADS_DOLT_PASSWORD", "supersecret")

    project = tmp_path / "proj"
    beads_dir = project / ".beads"
    beads_dir.mkdir(parents=True)

    bootstrap.write_kanban_config(project, "proj")
    raw = (beads_dir / "kanban.json").read_text()

    assert "supersecret" not in raw
    cfg = json.loads(raw)
    assert cfg["passwordEnv"] == "BEADS_DOLT_PASSWORD"
    assert "password" not in cfg  # only the env var reference, never the value


def test_database_fallback_slugifies_project_name(fake_home, tmp_path):
    _write_port_file(fake_home, 1)
    project = tmp_path / "proj"
    (project / ".beads").mkdir(parents=True)
    # No config.yaml → falls back to slugified name.

    bootstrap.write_kanban_config(project, "My Cool-Project")
    cfg = json.loads((project / ".beads" / "kanban.json").read_text())
    assert cfg["database"] == "my_cool_project"


def test_manual_init_does_not_touch_issues_jsonl(tmp_path):
    beads_dir = tmp_path / ".beads"
    bootstrap._manual_beads_init(beads_dir)
    assert (beads_dir / "config.json").exists()
    assert not (beads_dir / "issues.jsonl").exists(), (
        "Legacy JSONL placeholder must not be recreated — "
        "it mis-routes the Kanban UI away from Dolt."
    )
