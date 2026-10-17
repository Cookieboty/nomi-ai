---
---

fix(usage): more accurate usage billing from coding-tool logs. Gemini CLI: new `session-*.jsonl` logs (and subagent logs under `chats/<parent>/<child>.jsonl`) are scanned, repeated lines of the same message id keep the last one, cached tokens are subtracted from input. Codex: forked / subagent rollouts that replay the parent's history are no longer counted twice. Claude: cache writes are priced per tier (1h ≈ 2× input, 5m remainder), `speed: "fast"` requests are billed at 2×, and duplicated message ids keep the max usage. dsh: `inputTokens` is now treated as excluding cache (checked against the repo fixture only — not yet verified against real dsh logs); V0 `session.jsonl` is matched too. Existing ledger records keep their old accounting (missing fields mean the old basis).
