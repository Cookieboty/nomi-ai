// 层级契约：输入区（含向上弹出的斜杠面板 / 下拉菜单）必须高于聊天内容。
// 回归：聊天背景功能给 `.chat-container > *` 加了 z-index:1，而 `.input-container`
// 没有 z-index（backdrop-filter 使其成为 z=0 的层叠上下文），导致输入区里 z-index:50 的
// 斜杠面板整体被消息文字压住（mac 上看起来像"面板半透明、文字叠在一起"）。
// happy-dom 不做层叠计算，这里只能对 CSS 源码做契约断言；真实绘制顺序见 PR 说明里的 headless Chromium 验证。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { repoPath } from '@nomi-ai/repo-paths';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');
const app = read('src/App.css');
const tokens = readFileSync(repoPath('packages/ui/src/tokens.css'), 'utf8');

/** 取某个选择器（精确匹配整段选择器）的最后一个规则体 */
function ruleBody(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
  const re = new RegExp(`(?:^|[}/])\\s*${esc}\\s*\\{([^}]*)\\}`, 'g');
  const all = [...css.matchAll(re)].map((m) => m[1] ?? '');
  expect(all.length, `找不到规则 ${selector}`).toBeGreaterThan(0);
  return all.join('\n');
}
const token = (name: string) => Number(new RegExp(`${name}:\\s*(\\d+)`).exec(tokens)?.[1]);

describe('聊天区层级：输入区高于聊天内容', () => {
  it('z-index token 存在且输入区 > 聊天内容', () => {
    expect(token('--cd-z-chat-content')).toBeGreaterThan(0);
    expect(token('--cd-z-chat-input')).toBeGreaterThan(token('--cd-z-chat-content'));
  });

  it('.chat-container > 内容用 content token，.input-container 定位 + 用 input token', () => {
    const content = ruleBody(app, '.chat-container > *');
    expect(content).toMatch(/position:\s*relative/);
    expect(content).toMatch(/z-index:\s*var\(--cd-z-chat-content/);
    const input = ruleBody(app, '.input-container');
    expect(input).toMatch(/position:\s*relative/);
    expect(input).toMatch(/z-index:\s*var\(--cd-z-chat-input/);
  });

  it('.chat-container 自成层叠上下文，不与输入区抢层级', () => {
    expect(ruleBody(app, '.chat-container')).toMatch(/isolation:\s*isolate/);
  });

  it('斜杠面板用不透明的弹层背景（surface-raised），不是 transparent / 半透明字面量', () => {
    const palette = readFileSync(
      resolve(__dirname, '../src/components/SlashPalette/index.module.css'),
      'utf8',
    );
    const menu = ruleBody(palette, '.menu');
    expect(menu).toMatch(/background:\s*var\(--cd-color-surface-raised/);
    expect(menu).not.toMatch(/background:\s*(transparent|rgba)/);
    expect(menu).toMatch(/position:\s*absolute/);
  });
});

describe('全局背景层', () => {
  it('图片主题顶部与侧栏同色深，顶部底边、右栏和拖动分隔使用同一透明边框令牌', () => {
    const defaults = ruleBody(tokens, ':root');
    expect(defaults).toContain('--cd-panel-border: var(--cd-color-border)');
    expect(defaults).toContain('--cd-chat-header-bg: transparent');
    const image = ruleBody(tokens, 'html[data-chat-bg]');
    expect(image).toContain('--cd-chat-header-bg: var(--cd-panel-bg-subtle)');
    expect(image).toContain(
      '--cd-panel-border: color-mix(in srgb, var(--cd-color-border) 55%, transparent)',
    );
    const header = read('src/components/ChatHeader/index.module.css');
    expect(ruleBody(header, '.header')).toContain('--cd-chat-header-bg');
    const sidebar = read('src/components/Sidebar/index.module.css');
    expect(ruleBody(sidebar, '.sidebar')).toContain('--cd-panel-border');
    expect(ruleBody(app, '.files-rail')).toContain('--cd-panel-border');
    expect(ruleBody(app, 'html[data-chat-bg] .files-rail')).toContain('border-left: none');
    const splitter = ruleBody(
      app,
      'html[data-chat-bg] .center-changes-splitter::after,\nhtml[data-chat-bg] .files-rail-splitter::after',
    );
    expect(splitter).toContain('inset: 0 2px');
    expect(splitter).toContain('--cd-panel-border');
    expect(splitter).toContain('opacity: 1');
    const workspace = read('src/components/SessionWorkspace/SessionWorkspace.module.css');
    expect(ruleBody(workspace, '.panelHead')).toContain('--cd-panel-border');
    expect(ruleBody(workspace, '.railTreePane')).toContain('--cd-panel-border');
  });

  it('body 隔离层叠，背景固定在窗口最底层且不拦截点击', () => {
    expect(ruleBody(app, 'body')).toMatch(/isolation:\s*isolate/);
    const layer = ruleBody(app, '.chat-bg-layer');
    expect(layer).toMatch(/position:\s*fixed/);
    expect(layer).toMatch(/inset:\s*0/);
    expect(layer).toMatch(/z-index:\s*-1/);
    expect(layer).toMatch(/pointer-events:\s*none/);
    expect(layer).toMatch(/overflow:\s*hidden/);
    expect(layer).not.toMatch(/(?:backdrop-)?filter:/);
    expect(layer).not.toMatch(/opacity:/);
  });

  it('图片层自身 filter 模糊并用负 inset 盖住边缘，遮罩为固定深色且不做 backdrop 模糊', () => {
    const image = ruleBody(app, '.chat-bg-image');
    expect(image).toMatch(/inset:\s*calc\(var\(--cd-chat-bg-blur, 0px\) \* -2\)/);
    expect(image).toMatch(/background-size:\s*cover/);
    expect(image).toMatch(/background-position:\s*center/);
    expect(image).toMatch(/opacity:\s*var\(--cd-chat-bg-opacity/);
    expect(image).toMatch(/(?:^|\s)filter:\s*blur\(var\(--cd-chat-bg-blur/);
    expect(image).not.toContain('backdrop-filter');
    const mask = ruleBody(app, '.chat-bg-mask');
    expect(mask).toMatch(/inset:\s*0/);
    expect(mask).toMatch(/z-index:\s*1/);
    expect(mask).toMatch(/background:\s*rgb\(0 0 0 \/ \d+%\)/);
    expect(mask).not.toMatch(/filter:|--cd-chat-bg-opacity/);
    expect(app).not.toContain('--cd-chat-bg-color');
  });

  it('欢迎区、输入区和各栏不再单独模糊', () => {
    expect(ruleBody(app, '.welcome-content')).not.toContain('backdrop-filter');
    expect(ruleBody(app, '.input-container')).not.toContain('backdrop-filter');
    expect(app).not.toMatch(/--cd-chat-bg-blur-(left|center|right)/);
    const sidebar = read('src/components/Sidebar/index.module.css');
    const workspace = read('src/components/SessionWorkspace/SessionWorkspace.module.css');
    const input = read('src/components/MessageInput/index.module.css');
    for (const css of [sidebar, workspace, input]) expect(css).not.toContain('backdrop-filter');
  });

  it('设置、标题栏、引导和共享弹层使用全局面板背景，保留基础主题色板', () => {
    expect(ruleBody(app, 'html[data-chat-bg] .settings-overlay')).toMatch(
      /background:\s*transparent/,
    );
    expect(ruleBody(app, 'html[data-platform] .app-titlebar')).toContain('--cd-panel-bg');
    const settings = read('src/components/SettingsView/index.module.css');
    expect(ruleBody(settings, '.nav')).toContain('--cd-panel-bg-subtle');
    expect(ruleBody(settings, '.block')).toContain('--cd-settings-card-bg');
    const onboarding = read('src/components/Onboarding/index.module.css');
    expect(ruleBody(onboarding, '.card')).toContain('--cd-panel-surface-raised');
    const workspace = read('src/components/SessionWorkspace/SessionWorkspace.module.css');
    expect(ruleBody(workspace, '.wbFrame')).toContain('--cd-panel-surface');
    const pane = read('src/components/SessionWorkspace/WorkspacePane.module.css');
    expect(ruleBody(pane, '.wbTreePane')).toContain('--cd-chat-files-bg');
    const shared = readFileSync(repoPath('packages/ui/src/styles/base.css'), 'utf8');
    expect(ruleBody(shared, '.cd-modal')).toContain('--cd-panel-surface-raised');
    expect(ruleBody(shared, '.cd-sgroup')).toContain('--cd-settings-card-bg');
    const customTokens = ruleBody(tokens, 'html[data-chat-bg]');
    expect(customTokens).toMatch(/--cd-panel-blur:\s*none/);
    expect(customTokens).not.toMatch(/--cd-color-(?:bg|surface|text|accent|success|danger)\s*:/);
  });

  it('图片主题的消息、工具详情、Tab 和输入框与侧栏使用同色深，其他主题保留原色', () => {
    const defaults = ruleBody(tokens, ':root');
    const custom = ruleBody(tokens, 'html[data-chat-bg]');
    const backgrounds = [
      ['--cd-chat-user-bg', '--cd-color-user-msg'],
      ['--cd-chat-tool-detail-bg', '--cd-color-surface-sunken'],
      ['--cd-chat-markdown-bg', '--cd-color-surface-sunken'],
      ['--cd-chat-tab-bg', '--cd-color-surface'],
      ['--cd-chat-input-bg', '--cd-panel-surface-raised'],
      ['--cd-chat-files-bg', '--cd-panel-surface-raised'],
    ];
    for (const [name, fallback] of backgrounds) {
      expect(defaults).toContain(`${name}: var(${fallback})`);
      expect(custom).toContain(`${name}: var(--cd-panel-bg-subtle)`);
    }
    const sidebar = read('src/components/Sidebar/index.module.css');
    expect(ruleBody(sidebar, '.sidebar')).toContain('background: var(--cd-panel-bg-subtle)');
    const conversation = read('src/components/Conversation/index.module.css');
    expect(ruleBody(conversation, '.userBubble')).toContain('--cd-chat-user-bg');
    const tools = read('src/components/Conversation/Tool.module.css');
    expect(ruleBody(tools, '.pre')).toContain('--cd-chat-tool-detail-bg');
    expect(ruleBody(tools, '.diff')).toContain('--cd-chat-tool-detail-bg');
    const input = read('src/components/MessageInput/index.module.css');
    expect(ruleBody(input, '.inputWrapper')).toContain('--cd-chat-input-bg');
    expect(ruleBody(app, 'html[data-chat-bg] .files-rail')).toContain('--cd-panel-bg-subtle');
    const workspace = read('src/components/SessionWorkspace/SessionWorkspace.module.css');
    expect(ruleBody(workspace, '.panel[data-rail]')).toContain('background: transparent');
    expect(
      ruleBody(workspace, ':global(html[data-chat-bg]) .panel[data-rail] .railTreePane'),
    ).toContain('background: transparent');
  });

  it('图片主题 hover 保持背景透明，颜色平滑过渡并尊重减少动态效果', () => {
    const defaults = ruleBody(tokens, ':root');
    const custom = ruleBody(tokens, 'html[data-chat-bg]');
    for (const name of ['--cd-chat-hover-bg', '--cd-chat-hover-overlay']) {
      expect(defaults).toContain(`${name}: var(--cd-color-hover)`);
    }
    expect(custom).toContain(
      '--cd-chat-hover-bg: color-mix(in srgb, var(--cd-color-bg-subtle) 70%, transparent)',
    );
    expect(custom).toContain(
      '--cd-chat-hover-overlay: color-mix(in srgb, var(--cd-color-bg-subtle) 18%, transparent)',
    );
    const tools = read('src/components/Conversation/Tool.module.css');
    for (const selector of ['.diffLayoutBtn:hover', '.earlier:hover']) {
      expect(ruleBody(tools, selector)).toContain('--cd-chat-hover-overlay');
    }
    expect(ruleBody(tools, ':global(html[data-chat-bg]) .diffFold:hover')).toContain(
      '--cd-chat-hover-overlay',
    );
    const sidebar = read('src/components/Sidebar/index.module.css');
    expect(ruleBody(sidebar, '.brandWrap:hover')).toContain('--cd-chat-hover-overlay');
    for (const css of [tools, sidebar]) {
      expect(css).toContain('background-color var(--cd-duration-fast) var(--cd-ease)');
      expect(css).toContain('color var(--cd-duration-fast) var(--cd-ease)');
      expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition: none/s);
    }
  });

  it('工具调用无背景无边框，hover 只过渡文字颜色，保留状态色和键盘焦点', () => {
    const tools = read('src/components/Conversation/Tool.module.css');
    const group = ruleBody(tools, '.group,\n.block');
    expect(group).toContain('border: none');
    expect(group).toContain('background: transparent');
    expect(ruleBody(tools, '.head')).toContain('background: transparent');
    const hover = ruleBody(tools, '.head:hover');
    expect(hover).toContain('color: var(--cd-color-text)');
    expect(hover).not.toMatch(/background|border|box-shadow/);
    expect(ruleBody(tools, '.head,\n.verb,\n.target,\n.duration,\n.subCount')).toContain(
      'transition: color var(--cd-duration-fast) var(--cd-ease)',
    );
    expect(
      ruleBody(
        tools,
        '.head:hover .verb,\n.head:hover .target,\n.head:hover .duration,\n.head:hover .subCount',
      ),
    ).toContain('color: var(--cd-color-text)');
    expect(ruleBody(tools, '.statusDone')).toContain('--cd-color-success');
    expect(ruleBody(tools, '.statusError')).toContain('--cd-color-danger');
    expect(ruleBody(tools, '.head:focus-visible')).toContain('outline: 2px solid');
    expect(tokens).not.toContain('--cd-chat-tool-bg');
  });

  it('Markdown 代码和表头统一半透明底色，代码块内层不重复叠加，保留文字与高亮色', () => {
    const markdown = read('src/components/Conversation/Markdown.module.css');
    for (const selector of ['.inlineCode', '.codeBlock', '.md th']) {
      expect(ruleBody(markdown, selector)).toContain('background: var(--cd-chat-markdown-bg)');
    }
    expect(ruleBody(markdown, '.codeHead')).not.toMatch(/background:/);
    expect(ruleBody(markdown, '.codePre')).toContain('background: transparent');
    expect(ruleBody(markdown, '.codePre code.hljs')).toContain('background: transparent');
    expect(ruleBody(markdown, '.md')).toContain('color: var(--cd-color-text)');
    expect(markdown).toContain('color: var(--cd-color-accent-strong)');
    expect(markdown).toContain('color: var(--cd-color-success)');
    expect(markdown).toContain('color: var(--cd-color-warning)');
    const image = read('src/components/Conversation/MarkdownImage.module.css');
    for (const selector of ['.imgBtn', '.unsafe,\n.failed']) {
      expect(ruleBody(image, selector)).toContain('background: var(--cd-chat-markdown-bg)');
    }
  });

  it('Markdown 复制按钮悬停不出现不透明灰底，颜色渐变支持减少动态效果', () => {
    const markdown = read('src/components/Conversation/Markdown.module.css');
    expect(ruleBody(markdown, '.copyBtn:hover')).toContain('--cd-chat-hover-overlay');
    expect(ruleBody(markdown, '.copyBtn')).toContain(
      'background-color var(--cd-duration-fast) var(--cd-ease)',
    );
    expect(ruleBody(markdown, '.copyBtn')).toContain(
      'color var(--cd-duration-fast) var(--cd-ease)',
    );
    expect(ruleBody(markdown, '.copyBtn:focus-visible')).toContain('outline: 2px solid');
    expect(markdown).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition: none/s,
    );
  });

  it('本地功能卡片和 MCP 卡片、预设接入半透明面板背景，其他主题保持原底色', () => {
    const defaults = ruleBody(tokens, ':root');
    expect(defaults).toContain('--cd-panel-surface: var(--cd-color-surface)');
    expect(defaults).toContain('--cd-panel-surface-raised: var(--cd-color-surface-raised)');
    const local = read('src/components/LocalPanel/index.module.css');
    expect(ruleBody(local, '.card')).toContain('background: var(--cd-panel-surface)');
    const extensions = read('src/components/ExtensionsPanel/index.module.css');
    for (const selector of ['.card', '.preset']) {
      expect(ruleBody(extensions, selector)).toContain(
        'background: var(--cd-panel-surface-raised)',
      );
    }
    expect(ruleBody(extensions, '.preset:hover')).toContain('--cd-chat-hover-bg');
    expect(ruleBody(extensions, '.preset')).toContain(
      'background-color var(--cd-duration-fast) var(--cd-ease)',
    );
    expect(extensions).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition: none/s,
    );
  });

  it('设置和文件栏控件的 hover 使用透明蒙版、平滑过渡，减少动态效果时取消动画', () => {
    const settings = read('src/components/SettingsView/index.module.css');
    for (const selector of [
      '.back:hover,\n.navItem:hover',
      '.iconOpt:hover',
      '.theme:hover',
      '.helpToggle:hover',
    ]) {
      expect(ruleBody(settings, selector)).toContain('--cd-chat-hover-overlay');
    }
    expect(ruleBody(settings, '.back,\n.navItem,\n.iconOpt,\n.theme,\n.helpToggle')).toContain(
      'background-color var(--cd-duration-fast) var(--cd-ease)',
    );
    const pane = read('src/components/SessionWorkspace/WorkspacePane.module.css');
    for (const selector of ['.segBtn:hover', '.iconBtn:hover', '.chip:hover']) {
      expect(ruleBody(pane, selector)).toContain('--cd-chat-hover-overlay');
    }
    expect(ruleBody(pane, '.seg')).toContain('--cd-panel-surface-sunken');
    expect(ruleBody(pane, '.segBtn[data-active]')).toContain('--cd-panel-surface-raised');
    expect(ruleBody(pane, ':global(html[data-chat-bg]) .seg')).toContain('background: transparent');
    expect(ruleBody(pane, '.segBtn,\n.iconBtn,\n.chip')).toContain(
      'background-color var(--cd-duration-fast) var(--cd-ease)',
    );
    const workspace = read('src/components/SessionWorkspace/SessionWorkspace.module.css');
    expect(
      ruleBody(workspace, '.panel[data-rail] .panelHead .iconBtn:hover:not(:disabled)'),
    ).toContain('--cd-chat-hover-overlay');
    expect(ruleBody(workspace, '.panel[data-rail] .panelHead .iconBtn')).toContain(
      'background-color var(--cd-duration-fast) var(--cd-ease)',
    );
    for (const css of [settings, pane, workspace]) {
      expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition: none/s);
    }
  });

  it('设置页中性背景接入透明令牌，共享菜单使用深透明浮层', () => {
    for (const file of [
      'SettingsView/index.module.css',
      'SettingsView/GeneralHero.module.css',
      'SettingsView/SectionPage.module.css',
      'ModelsPage/index.module.css',
      'ModelsPage/TerminalCommandsCard.module.css',
      'ProvidersPage/index.module.css',
      'KnowledgePanel/index.module.css',
      'MemoryPanel/index.module.css',
      'SchedulePanel/index.module.css',
      'UsagePanel/index.module.css',
      'QualityPanel/index.module.css',
    ]) {
      expect(read(`src/components/${file}`)).not.toMatch(
        /background(?:-color)?:\s*var\(--cd-color-(?:surface(?:-raised|-sunken)?|bg(?:-subtle)?|hover)\)/,
      );
    }
    const custom = ruleBody(tokens, 'html[data-chat-bg]');
    expect(custom).toMatch(/--cd-settings-card-bg:\s*var\(--cd-panel-bg-subtle\)/);
    expect(custom).toMatch(/--cd-color-input-bg:\s*var\(--cd-panel-bg-subtle\)/);
    expect(custom).toMatch(/--cd-color-btn-secondary-bg:\s*var\(--cd-panel-bg-subtle\)/);
    const select = readFileSync(repoPath('packages/ui/src/styles/select.css'), 'utf8');
    expect(ruleBody(select, '.cd-dropdown__menu')).toContain('--cd-chat-popover-bg');
    expect(select).toContain('@media (prefers-reduced-motion: reduce)');
    const voice = readFileSync(repoPath('packages/voice/src/voice.css'), 'utf8');
    expect(ruleBody(voice, '.cd-voice-asset')).toContain('--cd-panel-surface-sunken');
  });

  it('上下文提示使用主题浮层颜色及同色箭头，保留用量状态色', () => {
    const defaults = ruleBody(tokens, ':root');
    const custom = ruleBody(tokens, 'html[data-chat-bg]');
    expect(defaults).toContain('--cd-chat-popover-bg: var(--cd-color-surface-raised)');
    expect(custom).toContain(
      '--cd-chat-popover-bg: color-mix(in srgb, var(--cd-color-bg-subtle) 92%, transparent)',
    );
    const workspace = read('src/components/SessionWorkspace/SessionWorkspace.module.css');
    const tip = ruleBody(workspace, '.contextRingTip');
    expect(tip).toContain('background: var(--cd-chat-popover-bg)');
    expect(tip).toContain('color: var(--cd-color-text)');
    expect(tip).toContain('box-shadow: var(--cd-shadow-popover)');
    expect(tip).not.toMatch(/#2a241c|#fff/);
    expect(ruleBody(workspace, '.contextRingTip::after')).toContain(
      'border-top-color: var(--cd-chat-popover-bg)',
    );
    expect(ruleBody(workspace, '.contextRingOfferBtn')).toContain('--cd-color-text-on-accent');
    expect(ruleBody(workspace, '.contextRingProg')).toContain('stroke: #f5a623');
    expect(ruleBody(workspace, ".contextRingProg[data-level='high']")).toContain('stroke: #e35d6a');
  });

  it('中央弹窗使用更深的透明底色，不影响设置内嵌或侧抽屉，不新增局部模糊', () => {
    const defaults = ruleBody(tokens, ':root');
    const custom = ruleBody(tokens, 'html[data-chat-bg]');
    expect(defaults).toContain('--cd-modal-bg: var(--cd-panel-surface-raised)');
    expect(custom).toContain(
      '--cd-modal-bg: color-mix(in srgb, var(--cd-color-bg-subtle) 94%, transparent)',
    );
    const shared = readFileSync(repoPath('packages/ui/src/styles/base.css'), 'utf8');
    const modal = ruleBody(shared, '.cd-modal:not(.cd-modal--inline):not(.cd-modal--drawer)');
    expect(modal).toContain('background: var(--cd-modal-bg)');
    expect(modal).not.toMatch(/backdrop-filter|opacity:/);
    expect(ruleBody(shared, '.cd-modal-overlay')).toContain('--cd-color-overlay');
    expect(ruleBody(shared, '.cd-modal')).toContain('--cd-panel-surface-raised');
    const workspace = read('src/components/SessionWorkspace/SessionWorkspace.module.css');
    expect(ruleBody(workspace, ':global(html[data-chat-bg]) .wbFrame')).toContain('--cd-modal-bg');
    const onboarding = read('src/components/Onboarding/index.module.css');
    expect(ruleBody(onboarding, ':global(html[data-chat-bg]) .card')).toContain('--cd-modal-bg');
    const plugin = read('src/components/PluginPanel/index.module.css');
    expect(ruleBody(plugin, '.row')).toContain('--cd-panel-surface');
    expect(ruleBody(plugin, '.row')).toContain('--cd-panel-border');
  });
});
