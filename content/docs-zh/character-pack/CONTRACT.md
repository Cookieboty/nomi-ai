# 角色包契约（v1）

单个角色包的冻结清单。角色包作者只需替换内容；除非契约版本升级，否则语音 clip / 动作 / 文件**名称**保持稳定。

官方角色本身就是一个普通的角色包，位于 [`characters/nomi`](../../characters/nomi)：未设置 `CHARACTER_PACK` 时，构建默认打包它，并走与任何第三方角色包完全相同的加载路径。

第三方换肤步骤见 [`REPLACING.md`](./REPLACING.md)。

## 权威定义

契约定义位于 [`@nomi-ai/character-contract`](../../packages/character-contract/README.md) 包中：

| 文件                                                                 | 内容                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`contract.json`](../../packages/character-contract/contract.json)   | 机器可读契约（模式、语音 clip / 动作 id、命中区 id、语义词汇表、文件名）                         |
| [`voice-ids.json`](../../packages/character-contract/voice-ids.json) | 稳定的语音 clip id ⇄ 旧版 i18n key 映射                                                          |
| `src/schemas.ts`                                                     | `manifest.json`、`persona.json`、`mapping.json`、`locales/*.json` 的 zod schema 与类型定义       |
| `validatePack()` / `validatePackDir()` (`/node`)                     | 结构化错误 / 警告 + 规范化后的角色包对象                                                         |
| `migrate*()`                                                         | 纯迁移函数（`skirt → hem`、旧版语音 key、旧版 `copy/` / `persona/` / `layout/` 文件）            |

角色包**只包含数据**——不包含代码。渲染引擎是由 `assets.mode` 选定的应用侧插件。

## 目录结构

```text
my-character.pack/
  manifest.json        id, contractVersion, assets.mode, capabilities, layout
  persona.json         displayName, shortName?, pronoun?, systemPromptIdentity, addressUser?, greetings[], tips?
  mapping.json         语义情绪 / 活动 / 手势 → 引擎资源 id（可选）
  locales/zh.json      角色文案：lines、wakePhrase、persona 覆盖
  locales/en.json
  rive/ sprite/ static/
  voice/<locale>/manifest.json + {id}.mp3
  onboarding/{welcome,profile,provider,privacy}.webp
  CREDITS.md / LICENSE
```

`manifest.credits`（`{ author, license, source }`，可选）用于生成内置模型清单与开源许可检查；官方包必须使用允许清单内的开源许可。

## manifest.json

| 字段                  | 必填   | 说明                                                                                              |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `schema`              | 是     | `1`                                                                                               |
| `id`                  | 是     | 小写字母、数字、`-`、`_`（≤ 64 字符）                                                             |
| `contractVersion`     | 是\*   | 整数；高于应用当前 `CHARACTER_CONTRACT_VERSION` 的包会被拒绝                                      |
| `assets.mode`         | 是\*   | `rive`（默认）/ `sprite` / `static`                                                               |
| `assets.*`            | 否     | 包内相对路径（`rive`、`sprite`、`static`、`voice`、`onboarding`）                                 |
| `capabilities`        | 否     | `riveMotions`、`spriteActions`、`expressions`、`voiceClipIds`、`lipSync`、`blink`；运行时按此降级 |
| `layout.window`       | 否     | `{ width, height }`，单位 px                                                                      |
| `layout.hitboxes`     | 否     | `{ head \| face \| body \| hand \| hem: { top, bottom, left, right } }`，占角色框比例             |
| `layout.bubbleAnchor` | 否     | `{ x, y }`，占角色框比例                                                                          |
| `rive`                | 否     | `{ artboard, stateMachine }` 覆盖项                                                               |
| `catalog`             | 否     | 模型清单条目：`displayName`、`description`、`author`、`tags`、`version`、`lastUpdated`            |

\* 旧版包会由迁移逻辑自动补全：`contractVersion` 取自 `engines.nomiPack`（否则为 `1`），顶层 `mode` 移至 `assets.mode`，`layout/hitboxes.json`（`{ regions, bubbleAnchor }`）合并进 `manifest.layout`。

## persona.json

角色身份的唯一数据源（系统提示身份段、问候语）。产品名称 / `appId` 保留在宿主品牌中，绝不从角色包读取。

```json
{
  "displayName": "Nomi·诺米",
  "shortName": "Nomi",
  "pronoun": "她",
  "systemPromptIdentity": "你是 Nomi（诺米），住在用户桌面上的 AI 伙伴。",
  "addressUser": "你",
  "greetings": ["你好呀，今天想聊点什么？"],
  "tips": ["记得多喝水。"]
}
```

`displayName`、`systemPromptIdentity` 和 `greetings` 为必填项（`greetings` 可为空数组——校验时会给出警告）。`displayName` 为全称，用于界面首次称呼该角色（「你好，我是 Nomi·诺米」）；`shortName`（可选，默认等于 `displayName`）用于后续提及（「显示 Nomi」「Nomi 大小」）。若某语言覆盖配置里设置了 `displayName` 但未设置 `shortName`，则该 `displayName` 也会同时用作简称。各语言的覆盖项写在 `locales/<lang>.json` → `persona` 中。
`pronoun`（可选）表示界面在句子中指代该角色的代词（「点她的『AI 对话』」、`"click her “AI chat”"`）。请按语言分别提供——中文写在 `persona.json`，英文写在 `locales/en.json` → `persona.pronoun` 中并使用主格形式（`she` / `he` / `it` / `they`；界面会自动派生出 `her` / `him` / `its` / `their`）。未单独设置该字段的语言默认使用中性代词「它」/ `it`；中文的值绝不会复用到英文界面。官方包使用「她」/ `she`。
没有 `persona.json` 的旧版包会从 `copy/<lang>.json` 和 `persona/system-prompt.md`（首个非空行）迁移，并给出警告。

## mapping.json

AI 与角色之间只交换**语义**事件（`emotion(name, weight)`、`activity(name)`、`gesture(name)`）；角色包负责将它们映射到自身的资源上。`emotions` 指向表情，`activities` 和 `gestures` 指向动作。值可以是单个资源 id 或数组（运行时随机择一）。
词表之外的名称以及包内未映射的名称会被忽略。**没有** `mapping.json` 的包会获得引擎默认映射（与官方包 [`characters/nomi/mapping.json`](../../characters/nomi/mapping.json) 相同）；提供了 `mapping.json` 的包则严格按其映射执行。

```json
{
  "emotions": { "happy": "smile_02", "sad": ["tears", "sigh"] },
  "activities": { "thinking": "think", "toolRunning": "typing_loop" },
  "gestures": { "wave": "wave", "thumbsUp": "thumbs_up" }
}
```

语义词汇表（`contract.json` → `mapping`，在 `@nomi-ai/character-contract` 中对应 `SEMANTIC_*` 类型）：

| 类别         | 名称                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emotions`   | `neutral` `happy` `sad` `angry` `surprised` `relaxed` `shy` `confused` `sleepy`                                                                                                                                                                                                                                                                                                                                               |
| `activities` | `idle` `thinking` `toolRunning`（`idle` 用于结束保持姿态，无需映射）                                                                                                                                                                                                                                                                                                                                                          |
| `gestures`   | `wave` `greet` `nod` `shakeHead` `bow` `salute` `pray` `okHand` `think` `explain` `eureka` `puzzled` `listen` `lookAround` `lookLeftRight` `peek` `heart` `blowKiss` `shy` `coverFace` `apologize` `surprise` `startle` `sigh` `smug` `aggrieved` `tears` `angry` `coldSweat` `daze` `cheer` `thumbsUp` `peace` `celebrate` `clap` `hop` `wink` `tongue` `cute` `reachOut` `work` `yawn` `stretch` `goodnight` `hum` `random` |

目标值 `random` 为引擎保留字（表示随机选择一个手势）。未知的语义名，以及未在 `capabilities`（情绪对应 `expressions`，其余对应 `riveMotions` / `spriteActions`）中声明的目标资源会触发警告，而非错误。

## locales/

角色文案（台词、提示语、语音字幕）**属于角色包本身**，不进入应用的全局 i18n 词典。主语言为 `zh`；建议同时提供 `zh` 与 `en`。

```json
{
  "persona": { "displayName": "Nomi", "systemPromptIdentity": "You are Nomi, …" },
  "wakePhrase": "Hi, Nomi",
  "lines": { "greet-hello": "Hi, I'm Nomi!", "tip-ask-me-anything": "Ask me anything." }
}
```

`lines` 的键为稳定的语音 clip id（旧版 i18n key 通过 `voice-ids.json` 解析）。桌面角色的提示语与问候语（`packages/renderer/src/mascot/tips.ts` 列出了所用的 id）从此处读取；若包中缺少某条台词，该处会保持静默，而不会回退到其他角色的文案。
`pnpm check:i18n` 会检查 `characters/` 下的每个包在 `zh` 与 `en` 中是否拥有一致的 `lines`（以及人设身份字段）。运行时台词会回退到主语言。当非主语言缺少 `zh` 中存在的键时，校验会发出警告。旧版 `copy/<lang>.json`（`displayName`、`wakePhrase`、`systemPromptIdentity`）会在警告的同时自动迁移。

## 模式（Modes）

| `manifest.assets.mode` | 必备素材                         | 说明                                    |
| ---------------------- | -------------------------------- | --------------------------------------- |
| `rive`（默认）         | `rive/character.riv`             | 主路径；强烈建议同时提供 sprite 作为回退 |
| `sprite`               | `sprite/` 分层立绘               | 可作为主模式或回退模式                  |
| `static`               | `static/character.webp`（或 png）| 无需 `.riv`，无需 43 个动作             |

## Rive

| 字段          | 默认值（Nomi）       | 覆盖方式                     |
| ------------- | -------------------- | ---------------------------- |
| Artboard      | `Nomi-full`          | `manifest.rive.artboard`     |
| State machine | `NomiFull`           | `manifest.rive.stateMachine` |
| File          | `rive/character.riv` | `manifest.assets.rive`       |

原生动作 clip 名称见 `contract.json` → `rive.nativeMotions`。缺失的动作可在 `manifest.capabilities.riveMotions` 中声明豁免；运行时会跳过未知 id。

## Sprite（43 个动作）

当包内提供 sprite（或模式为 `sprite`）时，`contract.json` → `sprite.actionIds` 中的动作 id 必须存在（或声明为缺失）。

## 语音（Voice）

Clip id 为**与角色名无关的稳定 id**（见 [`voice-ids.json`](../../packages/character-contract/voice-ids.json)）。清单条目使用 `id` + `i18nKey`；文件名为 `{id}.mp3`。
旧版 i18n-key 别名保留**一个大版本**的解析兼容（`resolveVoiceClipId()` / `contract.voice.legacyKeyAlias`）。

官方包的必选语言为 `zh`（见 `voice.requiredClipIds`；校验参数 `validatePack(…, { requireCompleteVoice: true })`）。

## 引导插画（Onboarding）

位于角色包 `onboarding/` 下的四个文件：

- `welcome.webp`
- `profile.webp`
- `provider.webp`
- `privacy.webp`

## 命中区（Hitboxes）

区域 id：`head` / `face` / `body` / `hand` / `hem`（下装；原名 `skirt`）。
在 `manifest.layout.hitboxes` 中声明（占角色框的比例），并可附加 `layout.bubbleAnchor`。
未声明命中区时，渲染器会按几何启发式规则划分触碰区域（官方 `characters/nomi` 包即不声明命中区）。
旧版 `layout/hitboxes.json` 仍会被读取并合并；仍包含 `skirt` 的包在加载时会自动规范化为 `hem`（`migrateHitboxIds()`）。

## 远程素材（Remote assets）

`assets.remote` 列出不随应用安装包分发、按需下载的素材类型（目前支持 `"rive"`）。声明为远程的素材可以不在包目录中出现；规范化后的包数据会在 `assets.remote` 中报告它们。

## 加载机制（Loading）

构建期：renderer / ai-chat 的 Vite 构建读取选定的包（`CHARACTER_PACK`，默认为 `characters/nomi`），并输出到 `dist/character/…`（`scripts/character/vite-plugin.mjs`）。源目录树中的任何文件都不会被覆盖。

运行时（`CharacterPackService`）：按 `userData/character-pack` → `resources/character-pack` → 内置包（打包后为 `resources/renderer/character`，开发态为仓库中的包）的顺序解析。
每个候选包都会经过 `validatePack` 校验；校验失败的包会被跳过（并记录日志）。覆盖包会以 `lenient: true` 校验，以确保在 2.0.5 上能加载的包依然可以加载：仅当缺少 2.0.5 强制要求的项（manifest `schema: 1`、非空字符串 `id`、已知模式、引导插画、主模式的核心素材）时才拒绝该包。`NON_STRUCTURAL_ISSUES` 中的非结构性检查（rive 文件大小、声明但缺失的回退素材、语音清单）、字段级 manifest 问题（不在 `[a-z0-9_-]` 范围内的 `id` 保留原值；未知命中区 id 与无效区域丢弃；其他不合法的可选字段丢弃）以及不合法的 `persona.json` / `mapping.json` / `locales/*.json`（忽略该文件）均只发出警告。内置包与 `character:check` 依然保持严格校验。
覆盖包素材通过 `character-pack://pack/…` 提供；视图通过 `character-pack:get-active` 获取当前包信息，其快照也包含该包的 `locales` 台词。详见 [`REPLACING.md`](./REPLACING.md)。

## 不在角色包内的内容

`appId`、产品名、更新通道、UI 主题令牌、界面文案（全局 i18n 词典）、角色商店 / 多角色切换界面 / 角色包商店。
（自定义协议 `character-pack://` 仅用于 B 方案包内资源。）

## 署名与许可（Attribution）

在包内附上 `CREDITS.md` / `LICENSE*`；它们会随包一同进入构建产物。
仓库内的角色包受 `assets-licenses.json` 覆盖管理（`pnpm check:licenses`）。
