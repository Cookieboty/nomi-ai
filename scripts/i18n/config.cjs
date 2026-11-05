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
    // 角色引擎把动作名 / 反应台词的界面 key 作为数据交给 renderer 显示
    { dir: 'packages/avatar-runtime/src', project: 'ui' },
    { dir: 'packages/voice/src', project: 'ui' },
    { dir: 'packages/ui/src', project: 'ui' },
  ],
  keySources: [],
  // 主进程文案（electron.* / ai-runtime.*，少数 ui.*）由 Go 内核使用：Go 源码与内嵌 JSON 里的字符串字面量计入使用
  goKeySources: ['apps/desktop-go'],
  goKeyNamespaces: ['electron', 'ai-runtime', 'ui'],
  // keepZh: intentional Chinese that must NOT be extracted as UI keys (e.g. wake words).
  // Do NOT list user-visible UI strings here — localize those instead.
  keepZh: [/voice[\\/]src[\\/]wake\.ts$/],
};
