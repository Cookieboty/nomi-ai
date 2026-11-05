---
---

fix(chat): chat history now lives in the app's data folder (`conversations/`) instead of the chat
window's browser storage, so long histories no longer hit the ~5 MB WebKit limit and silently stop
saving, and dev and packaged builds see the same conversations. Sending a message only appends it
instead of rewriting the whole conversation; other conversations load when you open them. On first
launch existing conversations (including ones whose list entry was never saved) are imported once and
checked; an interrupted import resumes next launch. The old browser-storage copy is kept for one
release so downgrading to 2.2.0 still shows it. Data export now includes the `conversations/` folder.
