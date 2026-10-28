---
'@nomi-ai/host-electron': minor
---

feat(cli): per-tab permission modes for coding-agent tabs (plan / manual / accept edits / auto / full access), mapped to each CLI's native flags. Codex tabs can now edit files and use the network (`codex exec` previously ran in its read-only, no-network sandbox); dsh gets `DSH_PERMISSION_MODE`; Grok no longer runs with `--yolo` by default (it now uses accept-edits unless full access is confirmed for that tab). Full access needs explicit confirmation and resets after restart. Design: docs/design/cli-permission-modes.md.
