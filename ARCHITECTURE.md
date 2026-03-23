# OpenClaw architecture for runtime-first forks

## Intent

This repository is still organized as a full OpenClaw product, but the code already contains a reusable runtime core behind the channel surfaces. The safest fork strategy is to preserve that core and make startup composition more explicit, rather than deleting channel code early.

## Current architecture summary

### 1. Core runtime

The practical runtime core is the combination of:

- agent execution and model/provider orchestration under `src/agents/**`
- session and transcript persistence across `src/config/sessions.ts`, `src/sessions/**`, and gateway session utilities
- plugin loading/registry/runtime in `src/plugins/**`
- tool assembly in `src/agents/openclaw-tools.ts`
- context-engine registration and resolution in `src/context-engine/**`
- memory prompt/search plumbing in `src/memory/**`

The gateway is not just a transport shell; it is the main composition root that wires those parts together.

### 2. Bootstrap and startup flow

Current foreground startup is:

1. CLI enters through `src/index.ts`.
2. Gateway CLI resolves options in `src/cli/gateway-cli/run.ts`.
3. Gateway bootstraps in `src/gateway/server.impl.ts`.
4. Startup loads config, secrets, plugin registry, channel manager, HTTP/WS transport, and sidecars.
5. Sidecars are started by `src/gateway/server-startup.ts`.

This means the gateway is already the cleanest stable host process for a product backend that wants to reuse runtime behavior.

### 3. Agent execution and orchestration

The embedded agent path is centered on `src/agents/pi-embedded-runner/**`. This is where OpenClaw keeps:

- run lifecycle
- streaming output handling
- history limiting and compaction
- tool splitting/execution wiring
- skills prompt wiring
- session manager integration

`src/gateway/server-methods/chat.ts` and `src/gateway/server-methods/sessions.ts` sit on top of this runtime and expose chat/session behavior to clients.

### 4. Sessions and memory

Session persistence is spread across a few layers by design:

- config/session-store resolution: `src/config/sessions.ts`
- session metadata/events: `src/sessions/**`
- gateway-facing session queries/history/transcript helpers: `src/gateway/session-*.ts`
- memory search/indexing/prompt integration: `src/memory/**`

The memory surface is already pluggable enough for extension work:

- memory prompt sections are registered via `src/memory/prompt-section.ts`
- plugin loading can register memory prompt builders and tools

### 5. Skills

Skills are not channel-specific. Workspace/local skill loading is exposed in `src/agents/skills.ts` and implemented through `src/agents/skills/workspace.ts`.

The embedded runner has a dedicated runtime seam for skill discovery in `src/agents/pi-embedded-runner/skills-runtime.ts`, which is a good sign for a runtime-first fork.

### 6. Plugins and extension points

Plugin registration is broad and important. `src/plugins/registry.ts` supports registration of:

- tools
- hooks
- providers
- speech/media/web-search providers
- gateway handlers
- HTTP routes
- services
- channel plugins
- context engines
- memory prompt sections

Plugin loading is runtime-driven from `src/plugins/loader.ts`, and plugin runtime helpers are built in `src/plugins/runtime/index.ts`.

### 7. Channels

Channels are substantial, but they are not the only architecture center. They are primarily composed through:

- channel plugin discovery: `src/channels/plugins/**`
- gateway lifecycle/start-stop: `src/gateway/server-channels.ts`
- gateway sidecar startup: `src/gateway/server-startup.ts`

Important finding: channel auto-start was already optional through `OPENCLAW_SKIP_CHANNELS`, which makes a minimal runtime profile feasible without destructive edits.

### 8. Web, control-plane, and transport surfaces

The gateway already exposes the surfaces a custom app/backend can reuse:

- WebSocket RPC/event transport via `src/gateway/server.impl.ts`, `src/gateway/server-methods.ts`, and `src/gateway/server-ws-runtime.ts`
- chat/session RPC methods in `src/gateway/server-methods/chat.ts` and `src/gateway/server-methods/sessions.ts`
- HTTP history transport in `src/gateway/sessions-history-http.ts`
- HTTP tool invocation in `src/gateway/tools-invoke-http.ts`
- plugin HTTP routes through `src/gateway/server/plugins-http.ts`

### 9. Context-engine and context assembly seams

OpenClaw already has a real context-engine abstraction in `src/context-engine/**`.

That is strategically important for your Elasticsearch-native direction because it means you do not need to invent a new top-level context abstraction first. You can likely extend the existing context-engine + plugin + memory seams for:

- schema-aware prompt assembly
- retrieval/result injection
- guardrails and validation metadata
- evidence/citation-oriented context blocks

## Current request flow

### WebSocket / control-plane chat

1. Client connects to gateway.
2. Gateway request dispatch goes through `src/gateway/server-methods.ts`.
3. Chat/session methods route into `src/gateway/server-methods/chat.ts` / `sessions.ts`.
4. Those methods invoke the embedded agent runtime, tools, sessions, and transcript updates.
5. Streaming and lifecycle events are broadcast back over gateway events.

### Tool execution

1. Gateway or agent runtime builds the tool set from `src/agents/openclaw-tools.ts`.
2. Core tools and plugin tools are merged.
3. Tool policy / allowlist / hook logic is applied.
4. Tool execution results feed back into session history and streaming responses.

## Forking guidance

For a product that puts its own backend in front of OpenClaw, the safest attachment point today is the gateway and its internal method handlers, not the channel adapters.
