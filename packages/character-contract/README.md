# @nomi-ai/character-contract

角色包契约：角色包里各数据文件的类型、zod schema、机器可读契约、校验与迁移。纯数据与纯函数，Node 与浏览器通用，不依赖 Electron。设计见 [docs/design/core-host-decoupling.md](../../docs/design/core-host-decoupling.md) §10.2、§10.3；字段说明见 [docs/character-pack/CONTRACT.md](../../docs/character-pack/CONTRACT.md)。

## 结构

| 路径                | 内容                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `contract.json`     | 机器可读契约（唯一来源）：模式、动作 / clip id、命中区 id、语义词表、文件名               |
| `voice-ids.json`    | 稳定语音 clip id ⇄ 旧 i18n key                                                            |
| `src/contract.ts`   | 契约常量与 `CHARACTER_CONTRACT_VERSION`                                                   |
| `src/schemas.ts`    | `manifest.json` / `persona.json` / `mapping.json` / `locales/*.json` 的 zod schema 与类型 |
| `src/migrations.ts` | 迁移纯函数：`skirt → hem`、旧语音 key、旧 `copy/` / `persona/` / `layout/` 文件           |
| `src/validate.ts`   | `validatePack(source)`：结构化错误 / 警告 + 规范化后的包；`createPackSource()`            |
| `src/copy.ts`       | `resolvePersona()` / `resolveLine()`：按语言取角色文案                                    |
| `src/node.ts`       | `/node` 入口：`readPackDir()` / `validatePackDir()` 从目录读包                            |

## 用法

```ts
import { createPackSource, validatePack } from '@nomi-ai/character-contract';
import { validatePackDir } from '@nomi-ai/character-contract/node';

const res = await validatePackDir('/path/to/my.pack', { requireCompleteVoice: false });
if (!res.ok) for (const e of res.errors) logger.warn(`${e.code} ${e.file} ${e.message}`);
```

- 核心入口（`.`）不 import node 内置模块，`tests/contract.test.ts` 会检查。
- 角色文案跟着角色包走，不进全局 i18n 词典；本包的校验信息是英文 + 稳定 `code`，界面要展示时按 `code` 翻译。
- 改 `contract.json` 的词表或列表时同步 `src/contract.ts` 的常量（测试会比对）。

```bash
pnpm --filter @nomi-ai/character-contract build
pnpm --filter @nomi-ai/character-contract test
```
