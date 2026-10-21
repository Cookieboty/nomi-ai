---
'@nomi-ai/ai-chat': patch
---

fix(usage): if the official Grok CLI exits right after it is started for the login check or quota read, the resulting asynchronous stdin error (EPIPE) is now handled and treated as "unavailable / try again later" instead of surfacing as an uncaught exception that could quit the app in production builds.
