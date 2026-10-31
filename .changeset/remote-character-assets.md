---
'@nomi-ai/ai-chat': patch
'@nomi-ai/renderer': patch
---

feat(character): the official character's Rive animation is downloaded on demand instead of shipping in the installer. The still image shows by default; turning on the animation in Settings downloads it from the remote character catalog (sha256-verified, cached for offline use, updated when the catalog has a new version) with progress and a retry button in that settings row.
