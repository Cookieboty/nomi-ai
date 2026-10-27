# 如何替换 / 整包换肤（第三方 & Fork）

面向白标、fork 作者与素材伙伴：在 **构建期** 用一整包角色素材覆盖官方落地路径，打出带自己角色的安装包。

> 这不是运行时商店，也不是多角色切换 UI。运行时 overlay（Scheme B）已支持：单包、校验失败回退内置。

完整契约见 [CONTRACT.md](./CONTRACT.md) / [contract.json](./contract.json)；设计师条目见 [designer-checklist.md](./designer-checklist.md)。

---

## 目标与边界

| 项       | 说明                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------- |
| 目标     | 构建前 `CHARACTER_PACK=… pnpm character:apply`，再 `pnpm build`，产物内嵌你的角色                       |
| 官方路径 | **未设置** `CHARACTER_PACK` 时：行为与今日官方 Nomi 完全一致（`character.generated.json` 的 `id=nomi`） |
| 覆盖方式 | v1 **原地覆盖**既有路径（不改名为 `default/`）                                                          |
| 单角色   | 产品永远只内置一套完整角色；无商店 / 切换 UI                                                            |

### 包内有什么 / 没有什么

**在包内（可换）：**

- 形象：`rive` / `sprite` / `static`（三选一为主模式）
- 引导插画：`onboarding/*.webp`（welcome / profile / provider / privacy）
- 语音 clip：`voice/<locale>/`（可缺，缺则回退 TTS / 静音，check 会警告）
- 文案与身份：`copy/zh.json`、`copy/en.json`；可选 `persona/system-prompt.md`
- 可选布局：`layout/hitboxes.json`（运行时命中 + bubbleAnchor；`skirt` 会规范为 `hem`）

**不在包内（勿指望 apply 改它们）：**

- UI 主题 / token
- `appId`、协议 scheme、更新通道
- 角色商店 / 多角色切换 UI
- 角色商店 / 多角色热切换 UI

---

## 三种模式怎么选

| `manifest.assets.mode` | 必备素材                             | 速度 / 成本 | 说明                                      |
| ---------------------- | ------------------------------------ | ----------- | ----------------------------------------- |
| **`static`**           | `static/character.webp`（或 `.png`） | **最快**    | 无 `.riv`、无 43 动作；适合先验证换肤链路 |
| **`sprite`**           | `sprite/` 分层 + `manifest.json`     | 中          | 可作主模式或 rive 回退                    |
| **`rive`**（默认）     | `rive/character.riv`                 | 最高保真    | 强烈建议同时带 `sprite/` 作回退           |

`static` 下一等公民：`character:check` **会跳过** riv / 43 动作校验。示范包：`examples/static-demo.pack`。

---

## 最小 static 包清单

从零或从示范包改，至少要有：

```text
my-character.pack/
  manifest.json          # schema=1, id, displayName, assets.mode=static
  static/character.webp  # 建议最长边 ≥ 1024、透明底
  onboarding/
    welcome.webp
    profile.webp
    provider.webp
    privacy.webp
  copy/zh.json           # 推荐
  copy/en.json           # 推荐
```

可选：`layout/hitboxes.json`、`persona/system-prompt.md`、`static/blink.webp`、`voice/zh/`。

`manifest.json` 最小示例：

```json
{
  "schema": 1,
  "id": "my-character",
  "displayName": { "zh": "我的角色", "en": "My Character" },
  "version": "1.0.0",
  "engines": { "nomiPack": ">=1 <2" },
  "assets": {
    "mode": "static",
    "static": "static/character.webp",
    "onboarding": "onboarding/",
    "copy": "copy/"
  },
  "defaults": {
    "wakePhrase": { "zh": "你好", "en": "Hello" },
    "primaryLocale": "zh",
    "voiceHint": "xiaoxiao",
    "voiceRate": 0.9,
    "voicePitch": 1.08
  }
}
```

---

## 推荐步骤（从示范包到可构建）

### 1. 复制示范包

静态最快路径：

```bash
cp -R examples/static-demo.pack ../my-character.pack
# 编辑 ../my-character.pack 内的立绘、onboarding、copy、manifest.id / displayName
```

完整官方导出（rive + sprite + voice）可参考：

```bash
pnpm character:init          # 刷新 examples/nomi.pack（从当前树导出）
cp -R examples/nomi.pack ../my-character.pack
```

### 2. 校验

```bash
pnpm character:check -- ../my-character.pack
# 或
node scripts/character/check.mjs ../my-character.pack
```

期望：`OK`（static 无 voice 时允许 `voice/zh not provided` 警告）。错误必须清零再 apply。

官方示范：

```bash
pnpm character:check                              # examples/nomi.pack
pnpm character:check -- examples/static-demo.pack
```

### 3. 应用（构建前）

```bash
CHARACTER_PACK=../my-character.pack pnpm character:apply
pnpm build
```

`apply` 会：

1. 按模式覆盖落地路径（见下表）
2. 写入 `character.generated.json`（renderer + mascot bundle）
3. 非官方 `id` 时同步 `model-list.json` 首项身份字段

| 素材       | v1 覆盖目标                                                     |
| ---------- | --------------------------------------------------------------- |
| Rive       | `packages/renderer/public/assets/models/rive/nomi-complete.riv` |
| Sprite     | `packages/renderer/public/assets/models/sprite/nomi/`           |
| Static     | `packages/renderer/public/assets/models/static/character.webp`  |
| Voice      | `packages/renderer/public/voice/nomi/`                          |
| Onboarding | `packages/ai-chat/src/components/Onboarding/art/`               |

> 路径文件名在 v1 **保持 nomi 字样**（原地覆盖，避免大范围资源移动）。区域 id 已为 `hem`；voice clip 已用稳定 id（旧 i18n key 别名保留一版）。

### 4. 恢复官方树（本地试完换肤后）

**未设置** `CHARACTER_PACK` 时，`pnpm character:apply` **只**保证 generated 配置为官方 nomi，**不会**自动还原已被覆盖的图片 / 语音 / onboarding / `model-list.json`。

本地试完后任选其一：

```bash
# A. 用 git 还原被改文件（推荐，零回归）
git checkout -- \
  packages/renderer/public/assets/models/ \
  packages/renderer/public/voice/nomi/ \
  packages/ai-chat/src/components/Onboarding/art/ \
  packages/renderer/src/mascot/character.generated.json \
  packages/bundle-ig-mascot/src/character.generated.json
# 若曾 apply 过 static，一并删掉额外目录：
rm -rf packages/renderer/public/assets/models/static

# B. 用官方示范包再 apply 一次盖回去
CHARACTER_PACK=examples/nomi.pack pnpm character:apply
```

然后无 env 再跑一次确认：

```bash
pnpm character:apply    # 应打印 already official nomi — no-op
```

---

## Brand-lock / SKIP

官方 CI 仍用 sprite 层 `brand-lock.json` 锁定 Nomi 画板。白标 / 自有素材 fork：

```bash
CHARACTER_PACK_SKIP_BRAND_LOCK=1 node scripts/brand/update-brand-lock.mjs --check
# 或在 CI / 本地测试环境导出该变量
```

也可参数化锁目录：

- `CHARACTER_PACK_SPRITE_DIR` / `BRAND_LOCK_MODEL_DIR` → 指向你的 sprite 目录

未设 SKIP 时，改了官方锁定层会导致 brand-lock check 失败——这是预期。

---

## 命令速查

| 命令                                        | 作用                                                            |
| ------------------------------------------- | --------------------------------------------------------------- |
| `pnpm character:check [-- <pack>]`          | 对照 `contract.json` 校验；默认 `examples/nomi.pack`            |
| `pnpm character:init`                       | 从当前树导出 / 刷新 `examples/nomi.pack`                        |
| `pnpm character:apply`                      | 无 `CHARACTER_PACK`：幂等确保 generated 为官方 nomi（不改素材） |
| `CHARACTER_PACK=<dir> pnpm character:apply` | 应用指定包并写 generated                                        |

CI（quality job）会跑 `pnpm character:check`，并对 `examples/static-demo.pack` 再跑一次 check。

---

## Scheme B（运行时 overlay）

把**完整**角色包放到其一即可（先到先得）：

1. `{userData}/character-pack/`（开发：Electron `app.getPath('userData')`）
2. `{resources}/character-pack/`（安装包 `extraResources`，源目录 `packages/electron/character-pack-resources/`）

校验失败 → 打日志 → 回退内置官方角色。渲染层通过 `character-pack:get-active` + `character-pack://pack/…` 取资源。

## 本能力不做

- 角色商店 / 多角色切换 UI
- 改 `appId` / 更新通道 / UI 主题

（已完成）`skirt→hem`、voice-id 稳定 id + 一版 legacy 别名、`layout/hitboxes.json` 运行时命中 + bubbleAnchor、Scheme B overlay。

需要完整字段与动作 id 列表时，请读 [CONTRACT.md](./CONTRACT.md)。
