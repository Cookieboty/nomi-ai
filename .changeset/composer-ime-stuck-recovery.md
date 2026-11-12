---
'@nomi-ai/ai-chat': patch
---

fix(chat): the composer is uncontrolled so IME composition no longer overwrites itself, and it recovers when Windows drops `compositionend`. The textarea keeps its own text; React only writes back when the draft really changes from outside (send, switch chat, completion, voice, history recall) and never during composition — the controlled `value` write-back is what erased the characters being typed and pushed the candidate window away from the caret. Composition is recognised by `inputType` as well as `isComposing`, because WebView2 can omit the flag, and the flag is cleared on blur or on an input that proves composition ended, so a lost `compositionend` no longer leaves the composer unable to take text.
