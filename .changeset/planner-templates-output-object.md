---
"@ai-hero/sandcastle": patch
---

The `parallel-planner` and `parallel-planner-with-review` init templates now parse the planner's `<plan>` output with `Output.object` and a hand-rolled Standard Schema validator instead of a bespoke regex helper. A missing tag or malformed plan JSON now throws `StructuredOutputError`.
