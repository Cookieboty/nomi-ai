---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
'@nomi-ai/types': patch
---

feat(cli): remove "External CLI" (user-added ACP coding assistants). The Settings → Coding assistants sidebar entry and page are gone, and only the built-in coding assistants can be used, through Nomi official accounts or third-party models.

- Old data is cleaned up on start: saved external CLI specs (`cli-plugins/external/`) are deleted, `external` tabs are no longer restored (their messages and carried context are removed with them, and their sidebar entries go away with the tabs), and a saved "External CLI" selection on the Coding assistants page falls back to the first assistant.
- The harness no longer accepts the `external` backend or a `pluginId`; unknown CLIs seen elsewhere (e.g. the fleet) still show a generic CLI icon.
