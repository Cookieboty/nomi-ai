---
---

fix(electron): running Python code now says plainly that it has no system-level isolation (it runs with your user's permissions, only with a temp working directory and a trimmed environment) and asks for a second confirmation before it runs; the tool description no longer calls it an isolated sandbox. JavaScript keeps its Node permission-model limits and a single confirmation.
