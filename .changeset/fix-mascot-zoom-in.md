---
---

fix(mascot): Ctrl/⌘ + + / - / 0 now reliably zoom the desktop mascot on every keyboard layout, including Shift+= and the numeric keypad. The main process intercepts the shortcut before Chromium's built-in zoom accelerator, and page-level zoom is locked so sizing stays in sync with the window.
