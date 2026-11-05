---
---

fix(chat): chat history saved in the app core no longer goes missing silently. Failed saves are retried
(and a chat whose creation never reached disk is re-created from what is on screen), with a one-time
notice if saving keeps failing; quitting waits briefly for pending saves. The chat window shows a
loading screen with import progress instead of a blank window, and an error with Retry instead of an
empty list when history can't be read. A damaged `index.json` is rebuilt from the message files
without re-importing old data, and old chats whose ids can't be file names (including Windows names
like `con` or `nul`) are imported under a new id instead of being skipped.
