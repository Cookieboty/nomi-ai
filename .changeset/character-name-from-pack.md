---
---

refactor(character): the product name and the character name are no longer mixed. The app name comes from one brand constant (`Nomi`; the settings header no longer reads "Nomi · 诺米"), and wherever the interface names the figure on the desktop it uses the active character's name from its pack (official build: zh "显示诺米" / "桌面诺米", en "Show Nomi" unchanged), so a white-label pack never shows the official name. The "Nomi prompt voice" setting is now "Character prompt voice"; the self-introduction lines move into the character pack; the wake word, when you have not set one, follows the active character (`wakePhrase` in its pack) instead of a fixed "你好，诺米" (a phrase you saved is kept). `pnpm check:character-leak` guards this in CI.
