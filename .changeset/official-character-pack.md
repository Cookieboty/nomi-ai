---
---

refactor(character): the official character is now an ordinary character pack, `characters/nomi`, loaded through the same path and validation as third-party packs. Builds read the selected pack directly (`CHARACTER_PACK=<dir> pnpm build`, default `characters/nomi`) instead of overwriting files in the tree; `pnpm character:apply` only validates, `pnpm character:init -- <dir>` scaffolds a new pack. The mascot's tips and greetings come from the active pack's `locales/{zh,en}.json`, so a different pack no longer speaks Nomi's lines, and the mascot tool descriptions no longer name the character.
