---
'@nomi-ai/ai-chat': patch
'@nomi-ai/contract': patch
'@nomi-ai/desktop-go': patch
---

fix(preview): 文件预览打开超过一小时后，保存会重新核对工作区和文件并换新的保存许可；文件被改过、换过或不再允许写入时不会覆盖，草稿可以复制或确认后放弃（#324）。 / After a file preview has been open for more than an hour, saving re-checks the workspace and the file and issues a new grant when the bytes are unchanged. An external edit, a replaced file, or a revoked permission is not overwritten, and the draft can be copied or discarded (#324).
