---
'@nomi-ai/ai-chat': patch
---

fix(desktop-go): Windows 上保存设置等私有文件时，如果目标文件正被杀毒软件、索引程序或另一次保存短暂占用，会稍等重试，不再直接保存失败（与 Node 版一致）。
