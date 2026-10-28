---
---

refactor(mascot): the AI tools that drive the mascot are renamed from `live2d_play_motion` / `live2d_set_expression` to `avatar_gesture` / `avatar_emotion` (same arguments). The old names are gone with no aliases; the app never shipped a Live2D runtime, so the remaining `live2d` names (IPC facade `ai:live2d:*` → `ai:avatar:*`, event `live2d:touch` → `avatar:touch`, `Live2dSeamPlugin` → `AvatarSeamPlugin`) are renamed too, and the unused `setParameter` call and `LIVE2D_NOT_AVAILABLE` error code are removed.
