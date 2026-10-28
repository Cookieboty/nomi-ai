---
'@nomi-ai/ai-chat': patch
'@nomi-ai/host-electron': patch
---

fix(ui): 图片主题选图出错时（超过 15 MB、格式不支持）在设置里提示原因，不再点了没反应；滑块写入失败时回到实际保存的值。过宽或过高的图片按最长边缩到 2560，PNG 缩小后仍存 PNG、保留透明。早期「纸白」主题的老用户升级后仍是奶油，不再被重置成 Sunset Orange。
