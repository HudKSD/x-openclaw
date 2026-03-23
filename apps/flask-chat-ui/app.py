from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Iterator, Protocol

from flask import Flask, Response, jsonify, render_template, request, stream_with_context

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BRIDGE = REPO_ROOT / "apps/flask-chat-ui/gateway_bridge.ts"


class GatewayServiceError(RuntimeError):
    pass


class GatewayService(Protocol):
    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]: ...

    def stream_chat(self, params: dict[str, Any]) -> Iterator[dict[str, Any]]: ...


class NodeBridgeGatewayService:
    def __init__(
        self,
        repo_root: Path | None = None,
        bridge_path: Path | None = None,
        node_binary: str | None = None,
    ) -> None:
        self.repo_root = repo_root or REPO_ROOT
        self.bridge_path = bridge_path or DEFAULT_BRIDGE
        self.node_binary = node_binary or os.environ.get("OPENCLAW_UI_NODE", "node")

    def _base_command(self) -> list[str]:
        return [self.node_binary, "--import", "tsx", str(self.bridge_path)]

    def _run_json(self, args: list[str]) -> dict[str, Any]:
        proc = subprocess.run(
            args,
            cwd=self.repo_root,
            capture_output=True,
            text=True,
            check=False,
            env=os.environ.copy(),
        )
        if proc.returncode != 0:
            stderr = proc.stderr.strip() or proc.stdout.strip() or "bridge command failed"
            raise GatewayServiceError(stderr)
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise GatewayServiceError(f"invalid bridge response: {exc}") from exc

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = json.dumps(params or {})
        return self._run_json([*self._base_command(), "call", method, payload])

    def stream_chat(self, params: dict[str, Any]) -> Iterator[dict[str, Any]]:
        payload = json.dumps(params)
        proc = subprocess.Popen(
            [*self._base_command(), "stream-chat", payload],
            cwd=self.repo_root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=os.environ.copy(),
        )
        assert proc.stdout is not None
        assert proc.stderr is not None
        try:
            for raw_line in proc.stdout:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError as exc:
                    raise GatewayServiceError(f"invalid streamed bridge response: {exc}") from exc
            proc.wait(timeout=2)
            if proc.returncode != 0:
                stderr = proc.stderr.read().strip() or "stream-chat bridge failed"
                raise GatewayServiceError(stderr)
        finally:
            if proc.poll() is None:
                proc.kill()


class AppConfig:
    def __init__(self) -> None:
        self.title = os.environ.get("OPENCLAW_UI_TITLE", "OpenClaw Custom UI")
        self.host = os.environ.get("OPENCLAW_UI_HOST", "127.0.0.1")
        self.gateway_url = os.environ.get("OPENCLAW_UI_GATEWAY_URL", "ws://127.0.0.1:18789")
        self.bridge_path = Path(os.environ.get("OPENCLAW_UI_BRIDGE", str(DEFAULT_BRIDGE)))
        self.node_binary = os.environ.get("OPENCLAW_UI_NODE", "node")


class FakeGatewayService:
    """Used only for lightweight manual/dev mode if needed."""

    def __init__(self) -> None:
        self.agents = [
            {"id": "main", "name": "Main"},
            {"id": "coding", "name": "Coding"},
        ]
        self.sessions = {
            "main": [
                {
                    "key": "agent:main:main",
                    "displayName": "Welcome chat",
                    "updatedAt": 1,
                    "lastMessageText": "Ask me anything",
                    "agentId": "main",
                }
            ]
        }

    def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        params = params or {}
        if method == "agents.list":
            return {"defaultId": "main", "agents": self.agents}
        if method == "sessions.list":
            agent_id = params.get("agentId", "main")
            return {"sessions": self.sessions.get(agent_id, []), "count": len(self.sessions.get(agent_id, []))}
        if method == "sessions.create":
            agent_id = params.get("agentId", "main")
            key = f"agent:{agent_id}:main-{len(self.sessions.get(agent_id, [])) + 1}"
            entry = {
                "key": key,
                "displayName": params.get("label") or "New chat",
                "updatedAt": 2,
                "lastMessageText": "",
                "agentId": agent_id,
            }
            self.sessions.setdefault(agent_id, []).insert(0, entry)
            return {"ok": True, "key": key, "sessionId": key, "entry": entry}
        if method == "sessions.reset":
            return {"ok": True}
        if method == "chat.history":
            return {
                "sessionKey": params.get("sessionKey"),
                "messages": [
                    {"role": "assistant", "content": [{"type": "text", "text": "Hello from mock mode."}]}
                ],
            }
        raise GatewayServiceError(f"unsupported fake method: {method}")

    def stream_chat(self, params: dict[str, Any]) -> Iterator[dict[str, Any]]:
        text = params.get("message", "")
        yield {"type": "ack", "runId": "mock-run"}
        yield {
            "type": "chat",
            "state": "delta",
            "runId": "mock-run",
            "message": {"role": "assistant", "content": [{"type": "text", "text": f"Echo: {text}"}]},
        }
        yield {
            "type": "chat",
            "state": "final",
            "runId": "mock-run",
            "message": {"role": "assistant", "content": [{"type": "text", "text": f"Echo: {text}"}]},
        }


def _text_from_message(message: dict[str, Any] | None) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if not isinstance(content, list):
        return ""
    chunks: list[str] = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            text = item.get("text")
            if isinstance(text, str):
                chunks.append(text)
    return "".join(chunks)


def _normalize_session_rows(result: dict[str, Any]) -> list[dict[str, Any]]:
    rows = result.get("sessions")
    if not isinstance(rows, list):
        return []
    normalized: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        normalized.append(
            {
                "key": row.get("key"),
                "sessionId": row.get("sessionId"),
                "displayName": row.get("displayName") or row.get("label") or row.get("key"),
                "updatedAt": row.get("updatedAt"),
                "lastMessageText": row.get("lastMessageText") or row.get("lastMessage") or "",
                "agentId": row.get("agentId"),
            }
        )
    return normalized


def create_app(test_config: dict[str, Any] | None = None) -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app_config = AppConfig()
    app.config.update(
        APP_TITLE=app_config.title,
        APP_HOST=app_config.host,
        GATEWAY_URL=app_config.gateway_url,
        TESTING=False,
    )
    if test_config:
        app.config.update(test_config)

    gateway_service = app.config.get("GATEWAY_SERVICE")
    if gateway_service is None:
        if os.environ.get("OPENCLAW_UI_MOCK") == "1":
            gateway_service = FakeGatewayService()
        else:
            gateway_service = NodeBridgeGatewayService(
                repo_root=REPO_ROOT,
                bridge_path=app_config.bridge_path,
                node_binary=app_config.node_binary,
            )
    app.config["GATEWAY_SERVICE"] = gateway_service

    def service() -> GatewayService:
        return app.config["GATEWAY_SERVICE"]

    def json_error(message: str, status: int = 500) -> tuple[Response, int]:
        return jsonify({"ok": False, "error": message}), status

    @app.get("/")
    def index() -> str:
        return render_template(
            "index.html",
            app_title=app.config["APP_TITLE"],
            gateway_url=app.config["GATEWAY_URL"],
        )

    @app.get("/api/bootstrap")
    def bootstrap() -> Response:
        try:
            agents_result = service().call("agents.list")
            agents = agents_result.get("agents", [])
            default_agent = agents_result.get("defaultId") or (agents[0]["id"] if agents else None)
            sessions_result = service().call(
                "sessions.list",
                {
                    "agentId": default_agent,
                    "limit": 50,
                    "includeDerivedTitles": True,
                    "includeLastMessage": True,
                },
            ) if default_agent else {"sessions": []}
            return jsonify(
                {
                    "ok": True,
                    "agents": agents,
                    "defaultAgentId": default_agent,
                    "sessions": _normalize_session_rows(sessions_result),
                }
            )
        except GatewayServiceError as exc:
            return json_error(str(exc), 502)

    @app.get("/healthz")
    def healthz() -> Response:
        return jsonify({"ok": True})

    @app.get("/api/agents")
    def agents() -> Response:
        try:
            return jsonify({"ok": True, **service().call("agents.list")})
        except GatewayServiceError as exc:
            return json_error(str(exc), 502)

    @app.get("/api/sessions")
    def list_sessions() -> Response:
        agent_id = request.args.get("agentId")
        try:
            result = service().call(
                "sessions.list",
                {
                    "agentId": agent_id,
                    "limit": 50,
                    "includeDerivedTitles": True,
                    "includeLastMessage": True,
                },
            )
            return jsonify({"ok": True, "sessions": _normalize_session_rows(result)})
        except GatewayServiceError as exc:
            return json_error(str(exc), 502)

    @app.post("/api/sessions")
    def create_session() -> Response:
        payload = request.get_json(silent=True) or {}
        agent_id = payload.get("agentId")
        label = payload.get("label")
        if not isinstance(agent_id, str) or not agent_id.strip():
            return json_error("agentId is required", 400)
        try:
            result = service().call("sessions.create", {"agentId": agent_id.strip(), "label": label})
            return jsonify({"ok": True, "session": result})
        except GatewayServiceError as exc:
            return json_error(str(exc), 502)

    @app.post("/api/sessions/reset")
    def reset_session() -> Response:
        payload = request.get_json(silent=True) or {}
        session_key = payload.get("sessionKey")
        if not isinstance(session_key, str) or not session_key.strip():
            return json_error("sessionKey is required", 400)
        try:
            result = service().call(
                "sessions.reset",
                {"key": session_key.strip(), "reason": "reset"},
            )
            return jsonify({"ok": True, **result})
        except GatewayServiceError as exc:
            return json_error(str(exc), 502)

    @app.get("/api/history")
    def history() -> Response:
        session_key = request.args.get("sessionKey", "").strip()
        if not session_key:
            return json_error("sessionKey is required", 400)
        try:
            result = service().call("chat.history", {"sessionKey": session_key, "limit": 200})
            return jsonify({"ok": True, **result})
        except GatewayServiceError as exc:
            return json_error(str(exc), 502)

    @app.post("/api/chat/abort")
    def abort_chat() -> Response:
        payload = request.get_json(silent=True) or {}
        session_key = payload.get("sessionKey")
        run_id = payload.get("runId")
        if not isinstance(session_key, str) or not session_key.strip():
            return json_error("sessionKey is required", 400)
        params = {"sessionKey": session_key.strip()}
        if isinstance(run_id, str) and run_id.strip():
            params["runId"] = run_id.strip()
        try:
            result = service().call("chat.abort", params)
            return jsonify({"ok": True, **result})
        except GatewayServiceError as exc:
            return json_error(str(exc), 502)

    @app.post("/api/chat/send")
    def stream_chat() -> Response:
        payload = request.get_json(silent=True) or {}
        session_key = payload.get("sessionKey")
        message = payload.get("message")
        thinking = payload.get("thinking")
        if not isinstance(session_key, str) or not session_key.strip():
            return json_error("sessionKey is required", 400)
        if not isinstance(message, str):
            return json_error("message is required", 400)

        params = {"sessionKey": session_key.strip(), "message": message, "thinking": thinking}

        @stream_with_context
        def generate() -> Iterator[str]:
            try:
                for event in service().stream_chat(params):
                    normalized = dict(event)
                    if normalized.get("type") == "chat":
                        normalized["text"] = _text_from_message(normalized.get("message"))
                    yield f"data: {json.dumps(normalized)}\n\n"
            except GatewayServiceError as exc:
                error_event = {"type": "error", "error": str(exc)}
                yield f"data: {json.dumps(error_event)}\n\n"

        return Response(generate(), mimetype="text/event-stream")

    return app


if __name__ == "__main__":
    application = create_app()
    port = int(os.environ.get("PORT", "5010"))
    application.run(host=application.config["APP_HOST"], port=port, debug=True)
