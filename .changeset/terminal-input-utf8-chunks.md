---
'@nomi-ai/ai-chat': patch
---

fix(side-workspace): 内置终端输入按 UTF-8 字节安全分块、串行写入，超长粘贴不再被静默丢弃。粘贴一大段中文 / emoji 时 xterm 一次交出的文本远超契约上限（65536 字符）而内核只收 65536 字节，以前整段被丢掉；现在按完整字符切块（代理对不拆开），逐块等待写回，并发粘贴 / 打字之间的顺序保持不变。某一块写入失败或被拒（进程已退出、重新打开的旧回执）时，丢弃尚未发出的剩余部分并在输入框上方显示可见的错误，不自动重试（避免把半条命令执行两遍）；重新打开终端后恢复。/ Terminal input is now split into UTF-8-safe chunks and written one chunk at a time, so a large paste is no longer silently dropped: xterm hands over long text in one callback while the kernel accepts at most 65536 bytes. Chunks never split a character (surrogate pairs stay together), writes are awaited in order across concurrent pastes and typing, and a failed or rejected write drops the not-yet-sent remainder and shows a visible error instead of retrying automatically (which could run half a command twice); reopening the terminal recovers.
