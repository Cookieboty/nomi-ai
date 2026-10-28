import { createLogger } from '@nomi-ai/ui';

import { api, hasTransport } from '../services/api';

const log = createLogger('voice-settings');

/**
 * 打开对话窗口的「设置 → 语音与屏幕 → 语音」（朗读引擎、语音输入都在这里）：契约 `nav.openVoiceSettings`。
 * 没有契约传输（浏览器预览 / 测试）时返回 false。
 */
export async function openVoiceSettings(): Promise<boolean> {
  if (!hasTransport()) return false;
  try {
    await api.nav.openVoiceSettings();
    return true;
  } catch (error) {
    log.error('打开语音设置失败', error);
    return false;
  }
}
