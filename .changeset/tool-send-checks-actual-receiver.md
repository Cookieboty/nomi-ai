---
'@nomi-ai/host-electron': patch
'@nomi-ai/bundle-ig-base': patch
---

fix(electron): with a mixed model setup (chat = cloud model, tools / summary = local model), "local models only" and the first-time cloud consent now check the model that actually receives the tool result. Previously `fs_read_text`, `fs_summarize`, `kb_search` and the browser / code tools checked the hard-coded tools / summary role, so a cloud chat model could still receive file text, knowledge-base snippets and file summaries while "local only" was on (and a local chat model was wrongly blocked in the reverse setup). The tool loop now passes the running provider to every tool; when it is unknown the tools check every candidate and fail closed.
