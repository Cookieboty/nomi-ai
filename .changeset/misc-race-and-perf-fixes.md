---
---

fix(electron): opening the chat window from several places at once (tray, shortcut, notification) now opens a single window. fix(voice): stopping hands-free / wake listening and starting again quickly no longer lets the previous session's pending recognition leak into the new one. fix(renderer): the 3D character reports frame rate once per second from an averaged window instead of on every frame, and automatic quality reduction now actually triggers when the frame rate stays low.
