---
"@ai-hero/sandcastle": patch
---

Add a `devices` option to the Docker and Podman sandbox providers that maps to `--device` flags, exposing host devices to the container (e.g. `/dev/kvm`). Each entry is a full device spec in `host[:container[:permissions]]` form; when omitted, no `--device` flags are added. SELinux `--security-opt` handling is intentionally out of scope and left to the user.
