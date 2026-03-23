# Runtime profiles

## Goal

A runtime profile makes startup composition explicit without rewriting the runtime. The first supported profile introduced here is meant to help a fork treat OpenClaw as an orchestration/runtime layer instead of a channel-first end-user product.

## Supported profiles

### `full`

Default OpenClaw behavior.

- gateway starts normally
- plugins still load
- skills still load
- sessions and memory still work
- channels may auto-start during sidecar startup

### `minimal-runtime`

Runtime-first startup profile.

- gateway still starts
- plugins still load
- plugin services still start
- skills/session/memory/tool/chat runtime behavior stays intact
- automatic channel startup is disabled

Aliases accepted by the CLI/runtime resolver:

- `minimal`
- `minimal-runtime`
- `custom-app`

## Current scope of the first safe step

This first step is intentionally conservative.

What `minimal-runtime` does today:

- formalizes a supported runtime profile at gateway startup
- keeps the gateway as the composition root
- disables automatic channel startup in `src/gateway/server-startup.ts`
- preserves the rest of the runtime surface so your app/backend can keep using gateway chat/session/tool APIs

What it does **not** do yet:

- remove channel code
- stop channel plugins from existing in the repo
- remove channel RPC surfaces
- create a brand-new app-facing API layer
- change session or tool semantics

## How to run

### CLI

```bash
openclaw gateway run --runtime-profile minimal-runtime
```

Accepted values:

- `full`
- `minimal`
- `minimal-runtime`
- `custom-app`

### Environment variable

```bash
OPENCLAW_RUNTIME_PROFILE=minimal-runtime openclaw gateway run
```

The CLI flag wins over the environment variable.

## Why this is the right first cut

This uses an existing optional boundary already present in the codebase: channel auto-start during gateway sidecar startup. That lets the fork reduce channel centrality without destabilizing:

- plugin loading
- workspace/local skills
- embedded agent execution
- session history
- memory integration
- transport surfaces already used by chat and tools
