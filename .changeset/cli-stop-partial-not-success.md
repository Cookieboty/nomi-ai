'@nomi-ai/ai-chat': patch
---

fix(cli): when a Codex, dsh or Grok turn is stopped by the user, killed, or exits with an error after it already printed some text, it is no longer recorded as a successful turn (and no longer raises a "task finished" reminder). A stop is shown as stopped with the partial text kept; a failure is shown as failed with the partial text kept before the error message.
