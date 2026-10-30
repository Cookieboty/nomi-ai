# @nomi-ai/ui

**中文：** Nomi 共享 UI：设计 token（CSS 变量）+ 轻量 React 组件。renderer（诺米窗口）与 ai-chat（对话窗口）共用。

**English:** Shared UI for Nomi: design tokens (CSS variables) + lightweight React components. Used by both the renderer (mascot window) and ai-chat (chat window).

```ts
import '@nomi-ai/ui/styles.css'; // includes tokens.css
import { Button, Modal, Select, Switch } from '@nomi-ai/ui';
```

- **Tokens**（`src/tokens.css`）：`--cd-color-*`、`--cd-radius-*`、`--cd-space-*`、`--cd-font-*`、`--cd-shadow-*`、`--cd-z-*`。默认暗色（深海军蓝 + 玻璃拟态 + 蓝/青强调），`[data-theme='light']` 预留浅色。
- **组件 / Components**：Button、IconButton、Input、Textarea、Select（native select）、Switch（role=switch）、Card/Panel、Modal/Dialog（Esc / backdrop close；close button aria-label「关闭」）、Tabs、Badge/Tag、Tooltip、Toast（ToastProvider + useToast）、EmptyState、FormField、Notice。
- 所有组件透传原生属性（`data-testid`、`aria-*` 等），类名统一 `cd-` 前缀，不使用 CSS Modules，便于跨包复用和覆盖。 / Components forward native props (`data-testid`, `aria-*`, etc.); class names use the `cd-` prefix (no CSS Modules) for easy reuse and overrides across packages.
