import { t } from '@nomi-ai/ui';
/**
 * 看板娘提示文案。本文件为 Nomi 原创内容，随项目以 MIT 许可发布。
 * （取代此前来自第三方项目、GPL-3.0 许可的 waifu-tips.json）
 */
export interface TipRule {
  selector: string;
  text: string[];
}

export const MOUSEOVER_TIPS: TipRule[] = [
  {
    selector: '#mascot-canvas',
    text: ['嗯？有什么事吗～', '我在这儿呢。', '要聊点什么吗？', '别戳啦，我会害羞的。'],
  },
  { selector: '#waifu-tool-ai-chat', text: ['打开聊天窗口，和我说说话吧。', '有问题尽管问我！'] },
  {
    selector: '#waifu-tool-switch-model',
    text: ['想换个人陪你吗？', '左键换下一位，右键打开角色列表～'],
  },
  { selector: '#waifu-tool-info', text: ['想了解这个项目吗？', '这里有关于我的介绍。'] },
  { selector: '#waifu-tool-photo', text: ['要拍照吗？我准备好了！'] },
  { selector: '#waifu-tool-voice-settings', text: ['语音设置在这里，右键可以细调。'] },
  { selector: '#waifu-tool-motion', text: ['想看我做个动作吗？右键可以挑一个。'] },
  { selector: '#waifu-tool-toggle-top', text: ['要我一直待在最前面吗？'] },
  { selector: '#waifu-tool-quit', text: ['要休息了吗？下次见～', '记得早点回来哦。'] },
];

export const IDLE_TIPS: string[] = [
  '休息一下眼睛吧，看看远处～',
  '喝口水吧，补充一下水分。',
  '坐久了记得起来活动活动。',
  '有想不通的问题，可以丢给我试试。',
  '今天也辛苦啦。',
];

/** 按小时段的问候（[起始小时, 结束小时]，闭区间）。 */
export const TIME_GREETINGS: Array<{ from: number; to: number; text: string }> = [
  { from: 5, to: 8, text: '早上好！新的一天开始啦。' },
  { from: 9, to: 11, text: '上午好，专注的时间到了。' },
  { from: 12, to: 13, text: '中午了，记得吃午饭哦。' },
  { from: 14, to: 17, text: '下午好，来杯茶提提神？' },
  { from: 18, to: 21, text: '晚上好，今天过得怎么样？' },
  { from: 22, to: 23, text: '已经很晚了，早点休息吧。' },
  { from: 0, to: 4, text: '这么晚还没睡？身体要紧哦。' },
];

export const MESSAGES = {
  welcome: '你好，我是你的桌面伙伴～',
  copy: '复制好了，记得注明出处哦。',
  visibility: '欢迎回来！',
  modelSwitched: (name: string) => t('{0} 来啦！', name),
};

export function greetingFor(hour: number): string {
  return TIME_GREETINGS.find((g) => hour >= g.from && hour <= g.to)?.text ?? MESSAGES.welcome;
}

/** 键盘关键词触发的台词（取代旧的固定语音 mp3）。由 TTS 朗读。 */
export const KEYWORD_LINES: Array<{ keywords: string[]; lines: string[] }> = [
  { keywords: ['function', 'def ', 'func '], lines: ['又写了一个函数呢。', '函数名起得不错！'] },
  { keywords: ['if'], lines: ['小心别漏了边界条件哦。'] },
  { keywords: ['for', 'while'], lines: ['循环要记得能结束哦。'] },
  { keywords: ['catch'], lines: ['错误处理做得好！'] },
  { keywords: ['await'], lines: ['异步等待中……'] },
  { keywords: ['todo'], lines: ['又欠下一个 TODO 啦。'] },
];

export const HOURLY_LINES: Array<{ from: number; to: number; lines: string[] }> =
  TIME_GREETINGS.map((g) => ({ from: g.from, to: g.to, lines: [g.text] }));
