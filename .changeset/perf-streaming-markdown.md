---
'@nomi-ai/ai-chat': patch
---

perf(chat): cheaper streaming Markdown and a lighter first paint — while a reply streams, the live body is re-rendered at most every 66–320 ms (tiered by body length and CPU core count) instead of every frame, and a code block that is still open is not syntax-highlighted until it closes or the turn ends (8000-character code block at 320 chars/s: main thread 34.8% → 8.8%, 537 → 206 DOM update batches). The syntax highlighter is now a lazily loaded chunk: the chat window's entry JS drops from 901 KB to 737 KB (285 KB → 234 KB gzip). `scripts/check-bundle-budget.mjs` reports first-paint size budgets in CI without failing it.
