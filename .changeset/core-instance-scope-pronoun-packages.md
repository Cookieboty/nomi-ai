---
'@nomi-ai/core': patch
'@nomi-ai/contract': patch
'@nomi-ai/character-contract': patch
'@nomi-ai/i18n': patch
'@nomi-ai/ui': patch
---

refactor(core): per-instance `CoreScope` (locale, verbose logging, private root, `CliTrace`) replaces module-level state; `ContractError` is matched by name and code; `persona.systemPrompt` returns the kernel-built prompt. `personaSchema` gains an optional `pronoun`, with `personaPronoun` / `pronounForms` helpers and neutral 它 / it defaults.
