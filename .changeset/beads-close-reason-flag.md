---
"@ai-hero/sandcastle": patch
---

Fix the Beads `CLOSE_TASK_COMMAND` template, which passed the completion message as a positional argument (`bd close <ID> "Completed by Sandcastle"`). `bd close` parsed it as a second issue ID and errored. It now uses the `--reason=` flag.
