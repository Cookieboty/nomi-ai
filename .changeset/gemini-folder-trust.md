---
'@nomi-ai/electron': patch
---

fix(gemini): stop blanket-bypassing Gemini CLI folder trust. Conversations no longer set `GEMINI_CLI_TRUST_WORKSPACE`; an untrusted folder now shows a translated "trust this folder in Gemini" error. Only the account-login flow trusts its own empty staging directory.
