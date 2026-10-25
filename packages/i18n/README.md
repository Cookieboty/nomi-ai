# @nomi-ai/i18n

Nomi 的统一多语言词典与运行时。词典按语言、项目、模块分层，源码只使用稳定 key。

## 目录

```text
src/locales/
  zh/                         # 基准语言，必须存在
    ui/chat-settings.json
    electron/common.json
    ai-runtime/providers.json
  en/
    ui/chat-settings.json
    electron/common.json
    ai-runtime/providers.json
```

每个 JSON 的 key 使用 `project.module.message` 格式，例如：

```json
{
  "ui.chat-settings.new-chat": "新对话"
}
```

代码中使用稳定 key：

```ts
t('ui.chat-settings.new-chat');
```

不要把中文原文写进新的 `t()` 调用，也不要在业务包里新增分散的语言文件。`catalog.ts` 是生成文件，运行时使用 `index.ts` 导出的 `createTranslator`、`getDictionary` 和类型。

## 新增文案或语言

新增文案时，在 `zh` 和每个已有语言目录的同一个模块文件中增加相同 key，然后运行：

```bash
node scripts/i18n/refresh-catalog.mjs
pnpm check:i18n
```

新增语言时，复制 `src/locales/zh` 的项目 / 模块结构到新的语言目录（例如 `ja`），保留完全相同的 key 集合并填写翻译，再运行上面的命令。检查脚本会检查缺失或多余 key、占位符不一致、项目内重复的基准文案、源码中的中文 key 和未使用 key。

`zh` 是 key 集合和占位符的基准语言。当前桌面运行时把系统中文映射为 `zh-CN`，词典目录仍使用 `zh`；新增语言还需要在应用语言偏好和 UI 文案中接入对应的 locale。
