---
'@nomi-ai/desktop-go': patch
'@nomi-ai/ai-chat': patch
---

feat(security): 沙箱用起来更顺：委派的子任务卡片和任务详情里也能直接授权，不在前台时桌面角色会提醒；编程助手知道自己在沙箱里，被挡下会停下说明、不再绕路；`.env` 这类密钥文件按文件授权，读凭据的「始终允许」只在这个项目里生效；后台任务可以预先允许沙箱类别（有 GitHub 对外动作时自动带上 SSH）；默认可写的缓存位置更多（Xcode、Gradle、Gem、Deno 等）。/ Smoother sandbox: grant from delegated sub-task cards and task details too, with a desktop-character reminder when Nomi isn't in front; coding agents know they're sandboxed and stop to explain instead of working around a block; secret files like `.env` are granted one at a time, and "Always allow" for credentials applies to that project only; background tasks can pre-allow sandbox categories (SSH is added automatically for GitHub actions); more cache locations are writable by default (Xcode, Gradle, gems, Deno and more).
