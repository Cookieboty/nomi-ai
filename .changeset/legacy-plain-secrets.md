---
'@nomi-ai/electron': patch
'@nomi-ai/ai-chat': patch
---

fix(security): CalDAV passwords saved in plain text by older versions are encrypted on startup once the system keychain is available; until then the calendar shows "Password not encrypted". Credentials typed into a calendar URL (`user:pass@`) move into the account fields, and calendar addresses shown in the app or written to a data export drop credentials, query strings and token-like path segments.
