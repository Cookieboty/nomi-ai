// 空会话首页的布局契约：欢迎区 + 聊天框 + 示例问题卡片 作为一整块垂直居中；
// 模型引导是输入框上的悬浮卡片，不占布局。
// 说明：happy-dom 不做布局计算，这里对 CSS 源码做契约断言（与 chatLayerOrder.test.ts 同一手法）；
// 真实视觉效果在 dev 里目视确认。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');
const app = read('src/App.css');
const welcome = read('src/components/ConversationWelcome/index.module.css');
const appTsx = read('src/App.tsx');
const chatBody = read('src/app/ChatBody.tsx');
const hintCss = read('src/components/MessageInput/ModelSetupHint.module.css');
const cardsCss = read('src/components/ConversationWelcome/PromptCards.module.css');

/** 取某个选择器的规则体（可能有多段，合并后断言） */
function ruleBody(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
  const re = new RegExp(`(?:^|[}/])\\s*${esc}\\s*\\{([^}]*)\\}`, 'g');
  const all = [...css.matchAll(re)].map((m) => m[1] ?? '');
  expect(all.length, `找不到规则 ${selector}`).toBeGreaterThan(0);
  return all.join('\n');
}

describe('空会话首页：整块居中', () => {
  it('空态由 .chat-column 的 data-empty 标记（新窗口 / 没发过消息）', () => {
    expect(appTsx).toMatch(/data-empty=\{chatEmpty/);
    // 空态口径：没有消息、没有斜杠卡
    expect(appTsx).toMatch(/const chatEmpty =/);
    expect(appTsx).toMatch(/slash\.cards\.length === 0/);
  });

  it('空态时对话列垂直居中', () => {
    expect(ruleBody(app, '.chat-column[data-empty]')).toMatch(/justify-content:\s*center/);
  });

  it('空态时输入区不再钉底、不再画顶部分隔线（与欢迎区连成一整块）', () => {
    const input = ruleBody(app, '.chat-column[data-empty] .input-container');
    expect(input).toMatch(/border-top:\s*none/);
    expect(input).toMatch(/background:\s*transparent/);
  });

  it('发过消息后回到常规布局：data-empty 只在空态出现', () => {
    // 非空态不设置该属性
    expect(appTsx).toMatch(/chatEmpty && mainShown \? 'true' : undefined/);
  });

  it('示例问题卡片在输入框下方渲染，且只在空会话的主对话里', () => {
    // footer 里 <MessageInput> 之后才是示例问题卡片
    const inputAt = appTsx.indexOf('<ModelSetupHint');
    const cardsAt = appTsx.indexOf('{nomiEmpty && <PromptCards />}');
    expect(inputAt).toBeGreaterThan(0);
    expect(cardsAt).toBeGreaterThan(inputAt);
    expect(appTsx).toMatch(/const nomiEmpty = chatEmpty && !tabs\.isCliTab/);
  });

  it('模型引导改成输入框上的悬浮卡片，不再占布局位置', () => {
    expect(appTsx).toMatch(/<ModelSetupHint/);
    expect(appTsx).not.toMatch(/<ModelSetupGuide/);
    // 卡片绝对定位 + 默认收起，靠 hover 显示
    const guide = ruleBody(hintCss, '.guide');
    expect(guide).toMatch(/position:\s*absolute/);
    expect(guide).toMatch(/opacity:\s*0/);
    expect(hintCss).toMatch(/\.host:hover\s+\.guide/);
  });
});

describe('欢迎区：图标彩色 + 结构', () => {
  it('产品图标不再被 grayscale 滤成灰白', () => {
    const mark = ruleBody(welcome, '.mark');
    expect(mark).not.toMatch(/filter:\s*grayscale/);
  });

  it('欢迎区自身也居中排布', () => {
    const content = ruleBody(welcome, '.content');
    expect(content).toMatch(/text-align:\s*center/);
    expect(content).toMatch(/align-items:\s*center/);
  });

  it('欢迎区不再负责渲染模型引导也不渲染示例问题卡片', () => {
    expect(chatBody).not.toMatch(/modelStatus=/);
    expect(chatBody).not.toMatch(/quick-action|PromptCards/);
  });
});

describe('示例问题卡片：与输入框同宽居中', () => {
  it('宽度走对话内容列宽并水平居中', () => {
    const prompts = ruleBody(cardsCss, '.prompts');
    expect(prompts).toMatch(/max-width:\s*var\(--cd-chat-content-w\)/);
    expect(prompts).toMatch(/margin:\s*[^;]*auto/);
  });
});
