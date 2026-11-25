---
'@nomi-ai/cli-catalog': patch
'@nomi-ai/ui': patch
---

fix(model-switch): 模型胶囊按底座清单的品牌去重图标，不重复画同一个模型品牌的图标

- `@nomi-ai/ui` 新增 `modelBrandIsNative`：只比较模型认出的品牌 id 与底座自家模型的品牌 id，不做底座 → 品牌的表单
- `@nomi-ai/cli-catalog` 清单新增 `branding.modelBrand`（纯展示元数据，界面信息 `BUILTIN_RENDERER` 里透传为 `brand`），7 个自带官方模型的底座在清单里各写一次；Antigravity 未声明自家模型品牌，因此不写，也不做这项去重
- 模型胶囊的自家品牌改从清单读，删掉原来写在模型切换组件里的底座 → 品牌对应表：底座自己的模型（Claude Code、Codex、Grok、Gemini、dsh、Kimi Code、MiniMax Code）只留底座图标，别家的模型、认不出厂商的模型、没有自家品牌的底座（含 Antigravity）照常画图标
- 回归测试直接读各清单的真实 `branding.modelBrand` 与模型 id 跑判定，不重写一张品牌表
