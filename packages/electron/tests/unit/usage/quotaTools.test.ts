/**
 * 额度卡的工具列表与插件清单一致（P9.4）：声明了 capabilities.usageQuota 的内置 CLI 才有订阅额度卡。
 */
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import { BUILTIN_MANIFESTS } from '@nomi-ai/cli-plugins';

import { QUOTA_TOOL_IDS } from '../../../src/usage/UsageService';

describe('QUOTA_TOOL_IDS', () => {
  it('matches the plugins that declare usageQuota', () => {
    const declared = Object.values(BUILTIN_MANIFESTS)
      .filter((m) => m.capabilities.usageQuota)
      .map((m) => m.id)
      .sort();
    expect([...QUOTA_TOOL_IDS].sort()).toEqual(declared);
  });
});
