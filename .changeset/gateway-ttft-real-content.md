---
'@nomi-ai/gateway': patch
---

fix(quality): the model quality page no longer treats the gateway's fallback commit (10-second wait or a run of metadata events) as the first content. Time to first token and generation speed now use when content actually arrived, and a stream that ends without content has no first-content time (#136).
