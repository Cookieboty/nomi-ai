---
'@nomi-ai/ui': patch
---

修复画布色被误加到所有主题的问题：`--cd-workspace-bg` 之前写在了 `:root, [data-theme='light']` 混合选择器里，选择器中的 `:root` 对任何主题都命中且位置靠后，把其余六个主题的画布一并改成了浅色。现改为只作用于浅色主题。 Fix the canvas colour leaking into every theme: `--cd-workspace-bg` was declared inside the `:root, [data-theme='light']` selector, whose bare `:root` matches all themes, repainting the canvas of the other six themes. It is now scoped to the light theme only.
