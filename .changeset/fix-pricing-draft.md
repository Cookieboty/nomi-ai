---
'@nomi-ai/ai-chat': patch
---

fix(usage): unsaved custom-price / exchange-rate edits are no longer wiped when a background usage refresh brings back an identical (but newly cloned) settings object. A real external change while editing keeps the draft and shows a conflict notice; a successful save shows the normalized values.
