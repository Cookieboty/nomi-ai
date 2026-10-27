---
'@nomi-ai/ai-chat': patch
'@nomi-ai/i18n': patch
---

fix(models): restore the optional test-model field on the custom provider inline form so endpoints without a `/models` list can probe and save (#161); cancelling add-provider invalidates in-flight detect so late results do not upsert (#162).
