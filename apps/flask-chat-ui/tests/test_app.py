from __future__ import annotations

import json
import socket
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
APP_ROOT = REPO_ROOT / "apps/flask-chat-ui"
sys.path.insert(0, str(APP_ROOT))

from app import NodeBridgeGatewayService, create_app  # noqa: E402


def _free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


@pytest.fixture()
def fake_gateway_server():
    port = _free_port()
    proc = subprocess.Popen(
        ["node", str(APP_ROOT / "tests/fake_gateway_server.mjs"), str(port)],
        cwd=REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert proc.stdout is not None
    ready = proc.stdout.readline().strip()
    if ready != f"ready:{port}":
        stderr = proc.stderr.read() if proc.stderr else ""
        proc.kill()
        raise RuntimeError(f"fake gateway failed to start: {ready} {stderr}")
    yield f"ws://127.0.0.1:{port}"
    proc.terminate()
    proc.wait(timeout=3)


@pytest.fixture()
def client(fake_gateway_server, monkeypatch):
    monkeypatch.setenv("OPENCLAW_UI_GATEWAY_URL", fake_gateway_server)
    service = NodeBridgeGatewayService(repo_root=REPO_ROOT)
    app = create_app({"TESTING": True, "GATEWAY_SERVICE": service})
    return app.test_client()


def test_index_renders(client):
    response = client.get("/")
    body = response.get_data(as_text=True)
    assert response.status_code == 200
    assert "Custom OpenClaw UI" in body
    assert "session-list" in body


def test_bootstrap_lists_agents_and_sessions(client):
    response = client.get("/api/bootstrap")
    payload = response.get_json()
    assert response.status_code == 200
    assert payload["ok"] is True
    assert payload["defaultAgentId"] == "main"
    assert [agent["id"] for agent in payload["agents"]] == ["main", "coding"]
    assert payload["sessions"][0]["displayName"] == "Main chat"


def test_healthz(client):
    response = client.get("/healthz")
    payload = response.get_json()
    assert response.status_code == 200
    assert payload == {"ok": True}


def test_create_session_and_reset(client):
    created = client.post("/api/sessions", json={"agentId": "coding"}).get_json()
    session_key = created["session"]["key"]
    assert created["ok"] is True
    sessions = client.get("/api/sessions?agentId=coding").get_json()
    assert sessions["sessions"][0]["key"] == session_key
    reset = client.post("/api/sessions/reset", json={"sessionKey": session_key}).get_json()
    assert reset["ok"] is True


def _read_sse_events(response) -> list[dict[str, object]]:
    raw = b"".join(response.response).decode("utf-8")
    events: list[dict[str, object]] = []
    for chunk in raw.split("\n\n"):
        chunk = chunk.strip()
        if not chunk.startswith("data:"):
            continue
        events.append(json.loads(chunk[5:].strip()))
    return events


def test_stream_chat_and_history(client):
    create_payload = client.post("/api/sessions", json={"agentId": "main"}).get_json()
    session_key = create_payload["session"]["key"]
    response = client.post(
        "/api/chat/send",
        json={"sessionKey": session_key, "message": "hello flask"},
        buffered=True,
    )
    events = _read_sse_events(response)
    assert events[0]["type"] == "ack"
    assert any(event.get("state") == "delta" for event in events if event.get("type") == "chat")
    assert any(event.get("state") == "final" for event in events if event.get("type") == "chat")

    history = client.get(f"/api/history?sessionKey={session_key}").get_json()
    texts = [
        "".join(item.get("text", "") for item in message.get("content", []) if item.get("type") == "text")
        for message in history["messages"]
    ]
    assert "hello flask" in texts
    assert "Echo: hello flask" in texts
