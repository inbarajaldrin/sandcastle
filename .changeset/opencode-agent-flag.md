---
"@ai-hero/sandcastle": patch
---

Add an `agent` option to `opencode()`, mapping to OpenCode's own `--agent` flag (e.g. `opencode("model", { agent: "build" })`). It selects a named agent/mode inside OpenCode for both headless (`run`) and interactive invocations, and is distinct from Sandcastle's `--agent` provider selector.
