---
'@nomi-ai/desktop-go': patch
---

fix(sandbox): 编程助手启动时例行读取 `~/.npmrc`、`~/.pypirc`（npm / pip 查源、查更新）不再弹沙箱授权请求：照样不让读（里面可能有发布令牌），只是不再打扰你。
