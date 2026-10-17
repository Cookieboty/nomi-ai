---
---

fix(chat): a streaming reply is now saved into the conversation that started it, so switching or creating a conversation mid-stream no longer leaks messages into the wrong chat. feat(chat): the send button turns into a stop button while Nomi is generating; stopping aborts the upstream request and keeps what was already generated. fix(chat): switching conversations quickly no longer lets a slower history load overwrite the visible messages.
