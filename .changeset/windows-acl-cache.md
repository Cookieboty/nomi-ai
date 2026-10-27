---
'@nomi-ai/electron': patch
---

Windows：私有文件写入不再每次都同步调用 icacls。userData 子目录只收紧一次，目录里新建的文件继承私有 ACL；其余目录按文件缓存，异步写入改用异步 icacls。
