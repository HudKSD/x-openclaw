from __future__ import annotations

import io
import json
import mimetypes
import threading
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import parse_qs
from wsgiref.simple_server import make_server

_thread_state = threading.local()


class _RequestProxy:
    def __getattr__(self, name: str) -> Any:
        req = getattr(_thread_state, "request", None)
        if req is None:
            raise RuntimeError("request context unavailable")
        return getattr(req, name)


request = _RequestProxy()


class Response:
    def __init__(
        self,
        response: str | bytes | Iterable[str | bytes] = b"",
        status: int = 200,
        mimetype: str = "text/plain",
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status_code = status
        self.mimetype = mimetype
        self.headers = {"Content-Type": mimetype, **(headers or {})}
        if isinstance(response, (str, bytes)):
            self.response = [response]
        else:
            self.response = list(response)

    def iter_encoded(self) -> Iterable[bytes]:
        for item in self.response:
            if isinstance(item, bytes):
                yield item
            else:
                yield item.encode("utf-8")

    def get_data(self, as_text: bool = False) -> str | bytes:
        data = b"".join(self.iter_encoded())
        return data.decode("utf-8") if as_text else data

    def get_json(self) -> Any:
        return json.loads(self.get_data(as_text=True))


class Request:
    def __init__(self, environ: dict[str, Any]) -> None:
        self.environ = environ
        self.args = {k: v[-1] for k, v in parse_qs(environ.get("QUERY_STRING", ""), keep_blank_values=True).items()}
        self._cached_json: Any = ...

    def get_json(self, silent: bool = False) -> Any:
        if self._cached_json is not ...:
            return self._cached_json
        try:
            length = int(self.environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            length = 0
        body = self.environ.get("wsgi.input", io.BytesIO()).read(length) if length > 0 else b""
        if not body:
            self._cached_json = None
            return None
        try:
            self._cached_json = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            if silent:
                self._cached_json = None
            else:
                raise
        return self._cached_json


class Flask:
    def __init__(self, import_name: str, template_folder: str = "templates", static_folder: str = "static") -> None:
        self.import_name = import_name
        module_path = Path(__file__).resolve().parent
        self.template_folder = module_path / template_folder
        self.static_folder = module_path / static_folder
        self.config: dict[str, Any] = {}
        self._routes: dict[tuple[str, str], Callable[..., Any]] = {}

    def route(self, path: str, methods: list[str]) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
            for method in methods:
                self._routes[(method.upper(), path)] = func
            return func

        return decorator

    def get(self, path: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        return self.route(path, ["GET"])

    def post(self, path: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        return self.route(path, ["POST"])

    def test_client(self) -> "TestClient":
        return TestClient(self)

    def run(self, host: str = "127.0.0.1", port: int = 5000, debug: bool = False) -> None:
        with make_server(host, port, self) as server:
            print(f" * Running on http://{host}:{port} (debug={debug})")
            server.serve_forever()

    def __call__(self, environ: dict[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
        method = environ.get("REQUEST_METHOD", "GET").upper()
        path = environ.get("PATH_INFO", "/")
        if path.startswith("/static/"):
            response = self._serve_static(path.removeprefix("/static/"))
        else:
            response = self._dispatch_request(method, path, environ)
        status_text = {200: "OK", 400: "BAD REQUEST", 404: "NOT FOUND", 500: "INTERNAL SERVER ERROR", 502: "BAD GATEWAY"}.get(response.status_code, "OK")
        start_response(f"{response.status_code} {status_text}", list(response.headers.items()))
        return response.iter_encoded()

    def _dispatch_request(self, method: str, path: str, environ: dict[str, Any]) -> Response:
        handler = self._routes.get((method, path))
        if handler is None:
            return Response("Not Found", status=404)
        _thread_state.request = Request(environ)
        _thread_state.current_app = self
        try:
            result = handler()
            return self._coerce_response(result)
        except Exception as exc:  # pragma: no cover - best-effort parity
            return Response(str(exc), status=500)
        finally:
            _thread_state.request = None
            _thread_state.current_app = None

    def _coerce_response(self, result: Any) -> Response:
        if isinstance(result, Response):
            return result
        if isinstance(result, tuple):
            body, status = result
            response = body if isinstance(body, Response) else Response(body, status=status)
            response.status_code = status
            return response
        if isinstance(result, (dict, list)):
            return jsonify(result)
        return Response(result)

    def _serve_static(self, filename: str) -> Response:
        file_path = self.static_folder / filename
        if not file_path.exists() or not file_path.is_file():
            return Response("Not Found", status=404)
        mime = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        return Response(file_path.read_bytes(), mimetype=mime)


class TestResponse(Response):
    pass


class TestClient:
    def __init__(self, app: Flask) -> None:
        self.app = app

    def open(self, path: str, method: str = "GET", json: Any = None, buffered: bool = False) -> TestResponse:
        body = b""
        headers = {}
        if json is not None:
            body = json_module.dumps(json).encode("utf-8")
            headers["CONTENT_TYPE"] = "application/json"
            headers["CONTENT_LENGTH"] = str(len(body))
        environ = {
            "REQUEST_METHOD": method.upper(),
            "PATH_INFO": path.split("?", 1)[0],
            "QUERY_STRING": path.split("?", 1)[1] if "?" in path else "",
            "wsgi.input": io.BytesIO(body),
            **headers,
        }
        captured: dict[str, Any] = {}

        def start_response(status: str, response_headers: list[tuple[str, str]]) -> None:
            captured["status"] = int(status.split(" ", 1)[0])
            captured["headers"] = dict(response_headers)

        chunks = list(self.app(environ, start_response))
        response = TestResponse(chunks, status=captured.get("status", 200), mimetype=captured.get("headers", {}).get("Content-Type", "text/plain"), headers=captured.get("headers", {}))
        response.response = chunks
        return response

    def get(self, path: str, **kwargs: Any) -> TestResponse:
        return self.open(path, method="GET", **kwargs)

    def post(self, path: str, **kwargs: Any) -> TestResponse:
        return self.open(path, method="POST", **kwargs)


json_module = json


def jsonify(obj: Any = None, /, **kwargs: Any) -> Response:
    payload = obj if obj is not None else kwargs
    return Response(json.dumps(payload), mimetype="application/json")


def url_for(endpoint: str, **values: Any) -> str:
    if endpoint == "static":
        return f"/static/{values['filename']}"
    raise KeyError(f"unsupported endpoint: {endpoint}")


def render_template(template_name: str, **context: Any) -> str:
    app = getattr(_thread_state, "current_app", None)
    if app is None:
      raise RuntimeError("current_app unavailable")
    raw = (app.template_folder / template_name).read_text(encoding="utf-8")
    rendered = raw
    for key, value in context.items():
        rendered = rendered.replace(f"{{{{ {key} }}}}", str(value))
    rendered = rendered.replace("{{ url_for('static', filename='app.css') }}", url_for("static", filename="app.css"))
    rendered = rendered.replace("{{ url_for('static', filename='app.js') }}", url_for("static", filename="app.js"))
    return rendered


def stream_with_context(fn: Callable[..., Iterable[str]]) -> Callable[..., Iterable[str]]:
    return fn
