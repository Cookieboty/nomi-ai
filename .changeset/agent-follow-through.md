---
'@nomi-ai/desktop-go': patch
---

fix(chat): Nomi 不再「说做完了就停」：这一轮的计划还有没做完的步骤时，会被提醒接着做（或把做不了的标成跳过并说明），每轮最多两次；自动续轮时只改了计划或原样重复之前的调用就停下，不再空转。任何工具输出超过 3 万字时先只看开头和结尾，需要时分页读中间，读出的内容同样受「仅本地模型可读文件」保护。/ Nomi no longer stops just because it says it's done: if the turn's plan still has unfinished steps it is reminded to continue (or mark them skipped with a reason), at most twice per turn; automatic continuation stops when a round only edits the plan or repeats earlier calls. Tool output over 30k characters is first shown by its beginning and end, and the middle can be read in pages, still covered by "only local models can read files".
