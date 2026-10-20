import { createLogger } from '@nomi-ai/ui';

const log = createLogger('voice-settings');

/**
 * 打开对话窗口的「设置 → 语音与屏幕 → 语音」（朗读引擎、语音输入都在这里）。
 * 旧版本没有这个接口时退回只打开对话窗口。
 */
export async function openVoiceSettings(): Promise<boolean> {
  const api = window.electronAPI as
    | {
        openVoiceSettings?: () => Promise<{ success: boolean; error?: string }>;
        openAiChat?: () => Promise<unknown>;
      }
    | undefined;
  try {
    if (api?.openVoiceSettings) return (await api.openVoiceSettings())?.success === true;
    await api?.openAiChat?.();
    return Boolean(api?.openAiChat);
  } catch (error) {
    log.error('打开语音设置失败', error);
    return false;
  }
}
