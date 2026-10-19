'@nomi-ai/ai-chat': patch
---

fix(desktop): undoing a file overwrite made by the assistant now works (it always reported a conflict before). The old version is restored from the app trash; if you edited the new file in between, the undo is refused and both copies are kept, and a failed undo step is rolled back.
