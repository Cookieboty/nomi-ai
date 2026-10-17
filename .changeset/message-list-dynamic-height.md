---
---

fix(chat): long conversations (50+ messages) no longer clip or overlap tall messages: rows are measured instead of assuming a fixed height, and are keyed by message id. fix(chat): the message list follows new content only while you are at the bottom; scrolling up to read no longer gets yanked back, and short conversations now follow the stream too.
