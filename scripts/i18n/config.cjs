/**
 * 统一词典检查配置。
 * 词典只存在 packages/i18n；project 是源码与词典的项目边界，
 * module 由 packages/i18n/src/locales/{language}/{project} 下的 JSON 文件表达。
 */
module.exports = {
  catalog: 'packages/i18n/src/locales',
  baseLanguage: 'zh',
  sources: [
    { dir: 'packages/ai-chat/src', project: 'ui' },
    { dir: 'packages/renderer/src', project: 'ui' },
    { dir: 'packages/voice/src', project: 'ui' },
    { dir: 'packages/ui/src', project: 'ui' },
    { dir: 'packages/electron/src', project: 'electron' },
    { dir: 'packages/cli-sdk/src', project: 'electron' },
    { dir: 'packages/cli-plugins/src', project: 'electron' },
  ],
  // 这些模块把稳定 key 作为数据返回给 UI，虽然调用点不在 t()/tr() 里，也要纳入未知 / 死 key 检查。
  keySources: ['packages/ai-runtime/src/providers'],
  // keepZh: intentional Chinese that must NOT be extracted as UI keys.
  // Prefer model-facing tool schemas / prompt fragments / parsers the agent reads
  // (DelegateService, p2/p3 tools, knowledge answer, schedule recurrence, episodes…).
  // Do NOT list user-visible UI strings here — localize those instead.
  keepZh: [
    /voice[\\/]src[\\/]wake\.ts$/,
    /electron[\\/]src[\\/]desktop[\\/](p2tools|p3tools|tools)\.ts$/,
    /electron[\\/]src[\\/]cli[\\/]delegate[\\/](core|DelegateService)\.ts$/,
    /electron[\\/]src[\\/]tts[\\/]legacy[\\/]/,
    /electron[\\/]src[\\/]knowledge[\\/](tokenize|answer)\.ts$/,
    /electron[\\/]src[\\/]schedule[\\/]recurrence\.ts$/,
    /electron[\\/]src[\\/]agents[\\/]parsers\.ts$/,
    /electron[\\/]src[\\/]memory[\\/]episodes\.ts$/,
    /electron[\\/]src[\\/]sandbox[\\/]/,
    /electron[\\/]src[\\/]desktop[\\/]parse[\\/]/,
  ],
};
