---
"@ai-hero/sandcastle": patch
---

Fix `syncOut` deleting the entire `.sandcastle` directory after a successful sync. Cleanup of temporary patch artifacts removed the whole `.sandcastle` directory once `patches/` was empty, wiping tracked files (e.g. `Dockerfile`, config) from the synced worktree. It now removes only the `patches/` directory.
