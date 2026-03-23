# Refactor plan for an Elasticsearch-native product backend

## Phase 0: discovery and boundary mapping

### Inspect

- `src/gateway/server.impl.ts`
- `src/gateway/server-methods.ts`
- `src/gateway/server-methods/chat.ts`
- `src/gateway/server-methods/sessions.ts`
- `src/gateway/sessions-history-http.ts`
- `src/gateway/tools-invoke-http.ts`
- `src/agents/pi-embedded-runner/**`
- `src/agents/skills.ts`
- `src/plugins/**`
- `src/context-engine/**`
- `src/memory/**`

### Findings

- keep gateway + embedded agent runtime intact first
- keep plugin and skills lifecycles intact first
- treat channels as startup adapters, not runtime core

## Phase 1: minimal runtime profile

### Objective

Introduce a supported runtime-first startup profile with minimal behavioral risk.

### Implemented in this change

- added a gateway runtime profile resolver
- added CLI support for `--runtime-profile`
- mapped `minimal-runtime` to “do not auto-start channels”
- left plugin loading, session flow, skills, and memory untouched

### Files modified in this phase

- `src/gateway/runtime-profile.ts`
- `src/gateway/server.impl.ts`
- `src/gateway/server-startup.ts`
- `src/cli/gateway-cli/run.ts`

### Rollback

- remove the runtime profile option and helper
- sidecar startup falls back to previous implicit full mode

## Phase 2: app-facing runtime adapter

### Objective

Create a clean internal API for your backend without replacing gateway internals.

### Recommended adapter surface

- send chat message
- stream responses
- fetch chat history
- create/resolve session
- invoke tools
- load plugin registry metadata
- load skills status

### Candidate implementation approach

- add a thin internal adapter over existing gateway method handlers
- keep the gateway request context as the source of truth
- avoid bypassing session/transcript writers directly

### Candidate files to inspect/modify

- `src/gateway/server-methods/chat.ts`
- `src/gateway/server-methods/sessions.ts`
- `src/gateway/sessions-history-http.ts`
- `src/gateway/tools-invoke-http.ts`
- a new internal adapter module under `src/gateway/` or `src/runtime-api/`

### Risks

- writing around existing transcript/session helpers can break history continuity
- direct session-file writes are unsafe; use session manager wrappers and gateway/session helpers

## Phase 3: context-engine integration for Elasticsearch

### Objective

Add Elasticsearch-native context engineering using existing seams.

### Likely extension points

- `src/context-engine/**` for retrieval/context assembly
- plugin tools for schema/index/query operations
- memory prompt sections for evidence/citation formatting
- gateway/plugin HTTP routes for internal backend services if needed

### Capabilities to add later

- schema-aware prompting
- index/field discovery
- safe query generation
- execution validation
- evidence/citation formatting
- tenant/workspace context injection

## Phase 4: reduce channel centrality further

### Possible later work

- separate channel bootstrap policy from gateway bootstrap more aggressively
- optionally suppress channel-specific gateway registrations in runtime-first mode where safe
- add a dedicated product/backend API package or adapter
- split reusable runtime composition from consumer-facing channel packaging

### Not for early phases

- deleting major channel subsystems
- replacing plugin loader
- replacing skill loading
- rewriting the embedded agent runner
