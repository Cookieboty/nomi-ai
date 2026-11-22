---
'@nomi-ai/desktop-go': patch
---

为主对话 CLI 运行时增加默认未启用的 convstore S1 持久化基础：单个版本化会话提交单元保存完整转录修订、原生绑定、交付覆盖、attempt/generation、队列及原始迁移数据；先持久化再执行，异常重启保守进入 uncertain，不自动重放。增加逐写入边界失败、磁盘满、真实测试子进程重启和旧 API 回归测试。仅通过临时目录 fixtures 验证，尚未接入真实主对话、CLI 或用户数据；Windows 的 v2 持久写入显式拒绝，等待实现可验证的耐久替换原语。
