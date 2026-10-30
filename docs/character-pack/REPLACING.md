# 如何替换 / 整包换肤（第三方 & Fork）

面向白标、fork 作者与素材伙伴：用一整包自己的角色素材打出安装包，或在运行时覆盖内置角色。

> 这不是运行时商店，也不是多角色切换 UI：一次只有一个角色生效。

完整契约见 [CONTRACT.md](./CONTRACT.md) / [contract.json](../../packages/character-contract/contract.json)（`@nomi-ai/character-contract`）；设计师条目见 [designer-checklist.md](./designer-checklist.md)。

---

## 目标与边界

| 项       | 说明                                                                                         |
| -------- | -------------------------------------------------------------------------------------------- |
| 构建期   | `CHARACTER_PACK=<dir> pnpm build`：renderer / ai-chat 直接读这个包，产物内嵌你的角色         |
| 运行时   | 把完整包放到 `userData/character-pack` 或 `resources/character-pack`，覆盖内置包             |
| 官方路径 | **未设置** `CHARACTER_PACK` 时构建官方包 `characters/nomi`——它和你的包走同一条加载与校验路径 |
| 不改源树 | 构建与运行都直接读包，仓库里的文件不会被覆盖；试完换肤不需要「恢复官方树」                   |
| 单角色   | 产品一次只带一套完整角色；无商店 / 切换 UI                                                   |

### 包内有什么 / 没有什么

**在包内（可换）：**

- 形象：`rive` / `sprite` / `static`（三选一为主模式）
- 引导插画：`onboarding/*.webp`（welcome / profile / provider / privacy）
- 语音 clip：`voice/<locale>/`（可缺，缺则回退 TTS / 静音，check 会警告）
- 身份：`persona.json`（`displayName`、`shortName`、`pronoun`、`systemPromptIdentity`、`addressUser`、`greetings`、`tips`）——对话的系统提示身份段只从这里来；`pronoun` 是界面里指代角色的代词（「点她的『AI 对话』」），不写时为「它」/ it，英文在 `locales/en.json` 的 persona 里单独给（如 `"pronoun": "he"`）
- 角色文案（台词、提示语、问候、语音字幕）：`locales/zh.json`、`locales/en.json`——跟着角色包走，不进应用的全局 i18n 词典；包里没有的那句提示，诺米就不说
- 可选语义映射：`mapping.json`（情绪 / 活动 / 手势 → 引擎资源 id）
- 可选布局：`manifest.layout`（窗口尺寸、命中区、bubbleAnchor；`skirt` 会规范为 `hem`）
- 可选署名：`manifest.credits`（`author` / `license` / `source`）、`CREDITS.md`、`LICENSE`
- 旧格式仍可读（校验会警告）：`copy/{zh,en}.json`、`persona/system-prompt.md`、`layout/hitboxes.json`

字段说明见 [CONTRACT.md](./CONTRACT.md) § persona.json / mapping.json / locales。

**不在包内：**

- UI 主题 / token、界面文案
- `appId`、产品名、协议 scheme、更新通道
- 角色商店 / 多角色切换 UI

---

## 三种模式怎么选

| `manifest.assets.mode` | 必备素材                             | 速度 / 成本 | 说明                                      |
| ---------------------- | ------------------------------------ | ----------- | ----------------------------------------- |
| **`static`**           | `static/character.webp`（或 `.png`） | **最快**    | 无 `.riv`、无 43 动作；适合先验证换肤链路 |
| **`sprite`**           | `sprite/` 分层 + `manifest.json`     | 中          | 可作主模式或 rive 回退                    |
| **`rive`**（默认）     | `rive/character.riv`                 | 最高保真    | 强烈建议同时带 `sprite/` 作回退           |

`static` 下一等公民：`character:check` **会跳过** riv / 43 动作校验。模板：`characters/test-dummy`。

---

## 最小 static 包清单

```text
my-character.pack/
  manifest.json          # schema=1, id, contractVersion=1, assets.mode=static
  static/character.webp  # 建议最长边 ≥ 1024、透明底
  onboarding/
    welcome.webp
    profile.webp
    provider.webp
    privacy.webp
  persona.json           # 推荐：角色身份
  locales/zh.json        # 推荐：角色文案（zh 与 en 的台词 key 要一致）
  locales/en.json        # 推荐
```

可选：`mapping.json`、`manifest.layout`、`static/blink.webp`、`voice/zh/`。

`manifest.json` 最小示例：

```json
{
  "schema": 1,
  "id": "my-character",
  "contractVersion": 1,
  "version": "1.0.0",
  "credits": { "author": "You", "license": "CC-BY-4.0", "source": "https://example.com" },
  "assets": { "mode": "static", "static": "static/character.webp", "onboarding": "onboarding" },
  "defaults": { "voiceHint": "xiaoxiao", "voiceRate": 0.9, "voicePitch": 1.08 },
  "layout": { "bubbleAnchor": { "x": 0.5, "y": 0.1 } }
}
```

`persona.json`（主语言 zh）与 `locales/en.json`：

```json
{
  "displayName": "小纸",
  "pronoun": "它",
  "systemPromptIdentity": "你是小纸，一个住在纸箱里的机器人。",
  "greetings": ["哔！"]
}
```

```json
{
  "persona": {
    "displayName": "Pip",
    "pronoun": "it",
    "systemPromptIdentity": "You are Pip, a robot living in a cardboard box."
  },
  "wakePhrase": "Hi, Pip",
  "lines": { "greet-companion": "Beep! Pip is online." }
}
```

`lines` 的 key 是稳定 clip id（诺米用到的提示语见 `packages/renderer/src/mascot/tips.ts`）。

---

## 推荐步骤

### 1. 新建包

```bash
pnpm character:init -- ../my-character.pack my-character
# 编辑 ../my-character.pack 内的立绘、onboarding、persona.json、locales/、manifest
```

需要 rive / sprite / 语音的完整示例，参考官方包 `characters/nomi`（其品牌图层受 brand-lock 保护，只能参考不能改）。

### 2. 校验

```bash
pnpm character:check -- ../my-character.pack
```

期望：`OK`（static 无 voice 时允许 `voice/zh not provided` 警告）。错误必须清零。
校验与运行时用的是同一个 `validatePack`（`@nomi-ai/character-contract`），check 通过的包运行时也能加载。

### 3. 构建

```bash
CHARACTER_PACK=../my-character.pack pnpm character:apply   # 预检（只读）
CHARACTER_PACK=../my-character.pack pnpm build
```

- renderer：整包输出到 `packages/renderer/dist/character/`，并生成 `assets/models/model-list.json`；
  安装包里是 `resources/renderer/character`，主进程把它当作内置包读取（人设、文案）。
- ai-chat：引导插画输出到 `packages/ai-chat/dist/character/onboarding/`。
- 开发态：`CHARACTER_PACK=../my-character.pack pnpm dev`，三个进程都直接读这个包。

不设 `CHARACTER_PACK` 就是官方包，无需任何还原步骤。

### 4. 运行时覆盖（不重新构建）

把**完整**角色包放到其一即可（先到先得）：

1. `{userData}/character-pack/`（开发：Electron `app.getPath('userData')`）
2. `{resources}/character-pack/`（安装包 `extraResources`，源目录 `apps/desktop-electron/character-pack-resources/`）

校验失败 → 打日志 → 回退内置包。界面通过 `character-pack:get-active` + `character-pack://pack/…` 取资源与文案。

运行时覆盖包与 `character:check` 用同一份契约校验；覆盖包按 2.0.5 的标准放行（`lenient`）：

- **仍会拒绝**（2.0.5 也拒绝的）：manifest 缺失或不是 JSON、`schema` 不是 1、`id` 为空、未知的 mode、
  `contractVersion` 高于应用支持的版本、缺 onboarding 插画、缺主模式的素材（rive 模式的 `.riv`、sprite 模式的
  `sprite/manifest.json`、static 模式的立绘）。
- **只警告、照常加载**：非结构性问题（`NON_STRUCTURAL_ISSUES`：`.riv` 小于 1000 字节、声明了但缺失的
  回退素材（如 rive 包的 `sprite/`）、有语音文件却没有 `voice/<locale>/manifest.json`、语音 clip 不全）；
  manifest 字段级问题（`id` 不是小写字母、数字、`-`、`_` 时原样使用；未知命中区 id、比例超出 0–1 或
  top ≥ bottom 的区域丢掉；空的 `displayName`、`rive.artboard` 等其他不合法的可选字段丢掉）；
  不合 schema 的 persona.json / mapping.json / locales（忽略该文件）。
  这些在 2.0.5 不检查，所以当时能加载的包现在仍能加载；日志里会逐条列出，建议用
  `pnpm character:check` 修掉。

`character:check` 与构建（`CHARACTER_PACK=…`）仍把这些都当错误。

---

## Brand-lock / SKIP

官方 CI 用 `characters/nomi/sprite/brand-lock.json` 锁定 Nomi 品牌图层；选别的包构建不影响这项检查。
自有素材 fork 如果改了官方包本身：

```bash
CHARACTER_PACK_SKIP_BRAND_LOCK=1 node scripts/brand/update-brand-lock.mjs --check
# 或在 CI / 本地测试环境导出该变量
```

也可参数化锁目录：`CHARACTER_PACK_SPRITE_DIR` / `BRAND_LOCK_MODEL_DIR` → 指向你的 sprite 目录。

---

## 命令速查

| 命令                                | 作用                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| `pnpm character:check [-- <pack>]`  | `validatePackDir` 校验；默认 `characters/nomi`（要求语音完整）  |
| `pnpm character:init -- <dir> [id]` | 以 `characters/test-dummy` 为模板新建包                         |
| `pnpm character:apply`              | 预检将要构建的包（`CHARACTER_PACK` 或 `characters/nomi`），只读 |
| `CHARACTER_PACK=<dir> pnpm build`   | 用指定包构建                                                    |
| `pnpm build:stand-in`               | 用替身包 `characters/test-dummy` 构建（e2e-headed 的 G5 用例）  |
| `pnpm check:character-leak`         | 官方角色名只在 `characters/nomi` 与产品品牌模块里出现           |
| `pnpm check:i18n`                   | 含 `characters/*/locales` 的 zh / en 一致性检查                 |

CI（quality job）会对 `characters/nomi`、`characters/test-dummy`、`examples/static-demo.pack` 跑 check。

## 本能力不做

- 角色商店 / 多角色切换 UI
- 改 `appId` / 产品名 / 更新通道 / UI 主题

需要完整字段与动作 id 列表时，请读 [CONTRACT.md](./CONTRACT.md)。
