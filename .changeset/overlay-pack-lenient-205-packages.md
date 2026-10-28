---
'@nomi-ai/core': patch
'@nomi-ai/character-contract': patch
---

fix(character): lenient `validatePack` accepts what 2.0.5 accepted (odd ids kept, unknown / invalid hitboxes dropped, other invalid optional manifest fields and invalid persona / mapping / locale files downgraded to warnings, `schema-lenient` issue code, `isLenientDowngrade`); strict mode is unchanged.
