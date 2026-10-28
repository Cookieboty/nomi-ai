---
'@nomi-ai/host-electron': patch
---

fix(electron): exporting local data no longer includes MCP secrets — every env / header value, URL credentials and command-line tokens are removed from `settings/mcp.json` regardless of whether they were stored encrypted (the old export only stripped values starting with `enc:`, so plaintext-saved keys leaked into the "secret-free" ZIP). fix(electron): when the system secure storage is unavailable (or encryption fails), saving a CalDAV password or an MCP secret / header is now refused with a clear error instead of silently writing plaintext; existing legacy values keep working. MCP header values are now always stored encrypted, and `calendar.json` is written with 0600 permissions.
