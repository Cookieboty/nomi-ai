---
'@nomi-ai/ai-runtime': patch
---

fix(usage): Nomi chat calls are now recorded under the model that was actually used, instead of the `default` placeholder or the pre-mapping alias. The provider's resolved model is used first (default → the provider's default model, `modelMap` aliases / wildcards applied); when the upstream does not report one, the same resolution is applied to the request. This makes per-model prices match, so cost is no longer missing or computed with the wrong alias price.
