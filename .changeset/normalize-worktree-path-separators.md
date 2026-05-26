---
"@ai-hero/sandcastle": patch
---

Fix worktree management on Windows by normalizing path separators. `git worktree list` reports paths with forward slashes even on Windows, while `node:path.join` uses backslashes — so `create()` would misclassify a reusable managed worktree as an external one and throw "already checked out", and `pruneStale()` would treat every active worktree as orphaned and delete it out from under running sandboxes. Path comparisons now normalize separators before matching.
