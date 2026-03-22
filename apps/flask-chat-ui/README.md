# Flask OpenClaw Custom UI

A focused Python chat app that gives OpenClaw a clean custom chat experience without the built-in Control UI.

This repo snapshot includes a tiny local `flask.py` compatibility shim so the app can run and be tested without downloading external Python packages in this environment. If you want to swap to the official Flask package later, the app surface is already structured around Flask-style handlers and responses.

## Features

- agent picker
- session list + create/reset actions
- chat history from the Gateway
- streaming assistant replies through a small Node bridge that reuses OpenClaw's Gateway client
- responsive single-page UI

## Run locally

```bash
python apps/flask-chat-ui/app.py
```

Then open <http://127.0.0.1:5010>.

## Gateway configuration

Default Gateway URL:

- `ws://127.0.0.1:18789`

Optional env vars:

- `OPENCLAW_UI_GATEWAY_URL`
- `OPENCLAW_UI_GATEWAY_TOKEN`
- `OPENCLAW_UI_GATEWAY_PASSWORD`
- `OPENCLAW_UI_GATEWAY_TLS_FINGERPRINT`
- `OPENCLAW_UI_GATEWAY_SCOPES`
- `OPENCLAW_UI_NODE`

For local app-only deployments, keep OpenClaw on loopback and let Flask be the only exposed surface.

## Mock mode

For quick UI-only checks without a real Gateway:

```bash
OPENCLAW_UI_MOCK=1 python apps/flask-chat-ui/app.py
```
