---
---

fix(chat): drawers and dialogs (e.g. "Add provider") now start below the window title bar, so the native window buttons (macOS traffic lights, Windows / Linux window controls) always stay fully visible and the title bar stays draggable; the drawer close button is now the text "Close" ("关闭") instead of an X icon. This replaces the earlier workaround that hid or dimmed the native window buttons and intercepted window close while a drawer was open.
