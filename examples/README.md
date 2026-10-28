# Character pack examples

官方角色是普通角色包，放在 [`characters/nomi`](../characters/nomi)；测试用替身包在
[`characters/test-dummy`](../characters/test-dummy)。这里只放示范包：

| Pack                | Mode     | 用途                                                                         |
| ------------------- | -------- | ---------------------------------------------------------------------------- |
| `static-demo.pack/` | `static` | 旧版包格式（`copy/`、`layout/`）的最小静图示范；check 会给迁移警告但仍能加载 |

新建角色包：`pnpm character:init -- <dir>`。第三方换肤步骤见
[`docs/character-pack/REPLACING.md`](../docs/character-pack/REPLACING.md)。
