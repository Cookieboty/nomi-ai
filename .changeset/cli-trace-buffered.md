---
'@nomi-ai/host-electron': patch
---

编程助手诊断记录改为缓冲异步写入（200ms / 256KB 合批），不再在每段 CLI 输出上同步追加文件；导出诊断包前先落盘。
