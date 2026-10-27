import type { ReleaseNotesEntry } from './types';

/** Product UI notes for 2.0.5 (derived from docs/releases/v2.0.5.md, not linked as paths). */
export const RELEASE_NOTES_V205: ReleaseNotesEntry = {
  version: '2.0.5',
  date: '2026-10-28',
  sections: [
    {
      id: 'new',
      items: [
        {
          en: 'When an update finishes downloading, Restart to update appears next to Settings and at the bottom of the settings nav — one click installs.',
          zh: '更新下载完成后，工作台「设置」旁与设置页导航底部出现「重启更新」，一点即可安装。',
        },
        {
          en: 'After an update restart, a What’s new panel summarizes this release; you can turn off auto-show and re-enable it in Settings.',
          zh: '更新重启后展示「更新日志」说明；可取消勾选「更新后显示更新日志」，并在设置里重新打开。',
        },
        {
          en: 'Character pack Scheme A/B tooling for pack authors (official app stays single-character Nomi).',
          zh: '角色包 Scheme A/B 工具链（官方仍为单角色 Nomi）。',
        },
      ],
    },
    {
      id: 'improvements',
      items: [
        {
          en: 'Smaller installers: drop duplicate asarUnpack binaries, ship only current-platform native prebuilds, and trim unused packaging weight.',
          zh: '安装包更小：去掉 asarUnpack 重复文件、只保留当前平台 native prebuilds，并裁掉未使用的打包体积。',
        },
      ],
    },
    {
      id: 'fixes',
      items: [
        {
          en: 'Custom-provider test-model field and cancel-add-provider detect race.',
          zh: '自定义供应商「测试模型」与取消添加时检测竞态。',
        },
        {
          en: 'Renaming from the collapsed sidebar expands first so the inline editor is visible.',
          zh: '折叠侧栏重命名时先展开，再显示行内编辑器。',
        },
        {
          en: 'Privacy-log clear no longer races with in-flight async writes.',
          zh: '清空隐私日志不再与在途异步写串行竞态。',
        },
        {
          en: 'Windows: more private-file writes use async atomic saves (quit still waits for pending work).',
          zh: 'Windows：更多私有文件改为异步原子写（退出仍等待未完成保存）。',
        },
      ],
    },
  ],
};
