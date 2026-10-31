---
'@nomi-ai/avatar-runtime': patch
---

feat(avatar-runtime): when Rive fails to start, `AvatarCanvas` shows the character's static image if it has one (`mascotRenderer` flag `static-fallback`), and only otherwise the layered sprite rig.
