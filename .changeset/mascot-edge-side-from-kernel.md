---
---

fix(mascot): the toolbar and speech bubble move to the other side of the character again when the
window sits at the right or left screen edge. The kernel now reports the window's real position and
work area (`mascot.screen`), since WebKit's `window.screenX` is not updated when the kernel moves
the window.
