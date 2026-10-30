# Character pack examples

官方角色是普通角色包，放在 [`characters/nomi`](../characters/nomi)；测试用替身包在
[`characters/test-dummy`](../characters/test-dummy)。这里只放示范包：

| Pack                | Mode     | 用途                                                                                           |
| ------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `static-demo.pack/` | `static` | 最小静图示范（当前布局：命中区在 `manifest.layout`，人设 `persona.json`，角色文案 `locales/`） |

旧布局（`layout/hitboxes.json`、`copy/<lang>.json`）仍能加载（迁移读取，check 给警告），由
`apps/desktop-electron/internal/core/tests/unit/character/packResolve.test.ts` 与 `packages/character-contract/tests` 的固定样例守住。

新建角色包：`pnpm character:init -- <dir>`。第三方换肤步骤见
[`docs/character-pack/REPLACING.md`](../docs/character-pack/REPLACING.md)。
