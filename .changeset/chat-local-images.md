---
---

fix(chat): images that a coding assistant or CLI saved as local files (for example the Feishu CLI
device-login QR code) now show in the reply instead of "Unsupported image link". The kernel reads
them only from a workspace, a granted folder or the system temp folder, only png / jpeg / gif /
webp up to 10 MB, and checks the content is really an image; otherwise the reply shows the path.
Closes #261.
