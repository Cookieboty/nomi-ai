---
'@nomi-ai/electron': patch
---

fix(release): macOS releases now ship a ZIP next to the DMG (x64 and arm64), and `latest-mac.yml` lists them. electron-updater can only install macOS updates from a ZIP, so with DMG-only releases the in-app update download failed on macOS. The first manual install still uses the DMG.
