---
'@nomi-ai/desktop-go': patch
---

编程助手在沙箱里运行没有执行位的技能脚本（"Permission denied"）时，不再误以为被沙箱拦截而停下：沙箱说明写明 CLI 自己的技能目录可读可执行，遇到这种情况改用解释器运行。
