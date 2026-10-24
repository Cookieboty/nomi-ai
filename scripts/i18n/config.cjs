/**
 * i18n 范围配置：扫描哪些目录、哪些文件故意保留中文（模型提示词 / 工具 schema / 中文解析数据），
 * 以及每个包从哪里 import `t`。
 */
module.exports = {
  packages: [
    {
      dir: 'packages/ai-chat/src',
      importFrom: '@nomi-ai/ui',
      dict: 'packages/ui/src/locales/en',
    },
    {
      dir: 'packages/renderer/src',
      importFrom: '@nomi-ai/ui',
      dict: 'packages/ui/src/locales/en',
    },
    {
      dir: 'packages/voice/src',
      importFrom: '@nomi-ai/ui',
      dict: 'packages/ui/src/locales/en',
    },
    { dir: 'packages/ui/src', importFrom: './i18n', dict: 'packages/ui/src/locales/en' },
    {
      dir: 'packages/electron/src',
      importFrom: '<rel>/i18n',
      dict: 'packages/electron/src/i18n/en.json',
    },
    // 内置插件与插件契约：文案经 cli-sdk 的 t()，由主进程注入翻译（electron/src/cli/pluginI18n.ts）
    {
      dir: 'packages/cli-plugins/src',
      importFrom: '@nomi-ai/cli-sdk',
      dict: 'packages/electron/src/i18n/en.json',
    },
    {
      dir: 'packages/cli-sdk/src',
      importFrom: './i18n',
      dict: 'packages/electron/src/i18n/en.json',
    },
  ],
  /** 反向（死 key）检查额外参考的源码：这些包产出的中文会在 UI 层经 t() 翻译 */
  keySources: ['packages/ai-runtime/src', 'packages/ai-sdk-client/src'],
  /** 这些文件里的中文是给模型看的提示词 / 工具说明，或用于解析中文输入的数据，不翻译 */
  keepZh: [
    /voice\/src\/wake\.ts$/,
    /renderer\/src\/mascot\/licenseTerms\.ts$/,
    /electron\/src\/desktop\/(p2tools|p3tools|tools)\.ts$/,
    /electron\/src\/tts\/legacy\//, // 旧版远程 TTS 测试（仅主进程日志）
    /electron\/src\/knowledge\/(tokenize|answer)\.ts$/,
    /electron\/src\/schedule\/recurrence\.ts$/,
    /electron\/src\/agents\/parsers\.ts$/,
    /electron\/src\/memory\/episodes\.ts$/,
    /electron\/src\/sandbox\//,
    /electron\/src\/desktop\/parse\//,
    /electron\/src\/i18n\//,
    /ui\/src\/i18n\.ts$/,
  ],
};
