---
'@nomi-ai/host-electron': patch
---

chore(release): macOS tag builds now verify that `latest-mac.yml` lists both the x64 and arm64 zip and that every listed file matches its size and sha512, and warn when the build is unsigned (macOS rejects unsigned auto-updates).
