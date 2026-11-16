# @nomi-ai/character-contract

## 0.1.0

### Minor Changes

- be4a6cc: feat(character-contract): a pack can declare remote assets (`assets.remote`, currently `"rive"`); a declared remote asset may be missing locally and is listed in the normalized pack's `assets.remote`.

### Patch Changes

- df95d1b: refactor(core): per-instance `CoreScope` (locale, verbose logging, private root, `CliTrace`) replaces module-level state; `ContractError` is matched by name and code; `persona.systemPrompt` returns the kernel-built prompt. `personaSchema` gains an optional `pronoun`, with `personaPronoun` / `pronounForms` helpers and neutral 它 / it defaults.
- 6dd7a97: fix(character): lenient `validatePack` accepts what 2.0.5 accepted (odd ids kept, unknown / invalid hitboxes dropped, other invalid optional manifest fields and invalid persona / mapping / locale files downgraded to warnings, `schema-lenient` issue code, `isLenientDowngrade`); strict mode is unchanged.
