// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MASCOT_CSP } from '../../src/security/csp';

const html = readFileSync(resolve(__dirname, '../../tts-config.html'), 'utf8');

describe('tts-config.html 与严格 CSP（#48）', () => {
  it('页面没有任何内联脚本（script-src 不含 unsafe-inline，内联脚本会被整段拦截）', () => {
    expect(MASCOT_CSP['script-src']).not.toContain("'unsafe-inline'");
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/\bsrc="[^"]+"/); // 只允许外部（构建后同源）脚本
      expect(body!.trim()).toBe('');
    }
    expect(html).not.toMatch(/\son(click|change|input|load)\s*=/i); // 也不能有内联事件处理器
  });

  it('入口脚本是 type=module 的 main.ts（Vite 会把它构建成同源模块）', () => {
    expect(html).toMatch(/<script type="module" src="\.\/src\/tts-config\/main\.ts"><\/script>/);
  });
});

describe('tts-config 页面逻辑（模块）在受控 IPC 下可用', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.resetModules();
    vi.unstubAllGlobals();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  async function mount() {
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/
      .exec(html)![1]!
      .replace(/<script[\s\S]*?<\/script>/g, '');
    const api = {
      getTTSConfig: vi.fn(async () => ({
        provider: 'fish-local',
        enabled: true,
        referenceId: 'nomi',
      })),
      saveTTSConfig: vi.fn(async () => undefined),
      resetTTSConfig: vi.fn(async () => undefined),
      testTTSConnection: vi.fn(async () => ({ success: true, message: 'ok', latency: 3 })),
      ttsSherpaStatus: vi.fn(async () => ({ state: 'ready', source: 'resources' })),
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = api;
    await import('../../src/tts-config/page');
    return api;
  }
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  it('加载 → 编辑 → 保存 / 检测 / 重置 都能走通', async () => {
    const api = await mount();
    await vi.waitFor(() => expect(api.getTTSConfig).toHaveBeenCalled());
    await vi.waitFor(() => expect($<HTMLSelectElement>('provider').value).toBe('fish-local'));

    $<HTMLInputElement>('baseUrl').value = 'http://127.0.0.1:9999';
    $('save-btn').click();
    await vi.waitFor(() => expect(api.saveTTSConfig).toHaveBeenCalled());
    expect((api.saveTTSConfig.mock.calls[0] as unknown[])[0]).toMatchObject({
      provider: 'fish-local',
      baseUrl: 'http://127.0.0.1:9999',
    });

    $('health-btn').click();
    await vi.waitFor(() => expect(api.testTTSConnection).toHaveBeenCalled());

    vi.stubGlobal('confirm', () => true);
    $('reset-btn').click();
    await vi.waitFor(() => expect(api.resetTTSConfig).toHaveBeenCalled());
  });
});

describe('tts-config 页面本地化（#48）', () => {
  afterEach(async () => {
    const { applyLocale } = await import('@nomi-ai/ui');
    applyLocale('zh-CN');
    document.body.innerHTML = '';
    vi.resetModules();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  async function mountIn(locale: 'en' | 'zh-CN') {
    const ui = await import('@nomi-ai/ui');
    ui.applyLocale(locale);
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/
      .exec(html)![1]!
      .replace(/<script[\s\S]*?<\/script>/g, '');
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      getTTSConfig: vi.fn(async () => ({
        provider: 'fish-local',
        enabled: true,
        referenceId: 'nomi',
      })),
      ttsSherpaStatus: vi.fn(async () => ({ state: 'ready', source: 'resources' })),
    };
    const page = await import('../../src/tts-config/page');
    const { applyStaticText } = await import('../../src/tts-config/staticText');
    return { page, applyStaticText, ui };
  }
  const q = (sel: string) => document.querySelector(sel) as HTMLElement;

  it('英文界面：静态文案、带格式的句子与占位符、动态状态都是英文', async () => {
    await mountIn('en');
    expect(q('h1').textContent).toBe('TTS voice settings');
    expect(document.title).toBe('TTS voice settings');
    const intro = q('[data-i18n="intro"]');
    expect(intro.querySelector('strong')?.textContent).toBe('offline voice');
    expect(intro.textContent).toMatch(/^Uses the built-in offline voice by default \(sherpa-onnx/);
    const codes = [...q('[data-i18n="sherpa-hint"]').querySelectorAll('code')].map(
      (c) => c.textContent,
    );
    expect(codes).toEqual(['NOMI_SHERPA_TTS_MODEL_DIR', '../models/vits-zh-hf-theresa']);
    expect((q('#apiKey') as HTMLInputElement).placeholder).toBe(
      'Leave empty to keep the saved key',
    );
    expect(q('[data-i18n="opt-fish-local"]').textContent).toBe(
      'Advanced: local Fish (fish-speech)',
    );
    await vi.waitFor(() =>
      expect(q('#status-text').textContent).toBe(
        'Local Fish (advanced) · preset nomi (silent until ready)',
      ),
    );
    // 页面上不应再残留任何中文（品牌名 / 代码除外本来就是英文）
    expect(/[\u4e00-\u9fff]/.test(q('main').textContent ?? '')).toBe(false);
  });

  it('切换语言：静态文案与动态状态都重新渲染', async () => {
    const { page, applyStaticText, ui } = await mountIn('en');
    await vi.waitFor(() => expect(q('#status-text').textContent).toMatch(/^Local Fish/));
    ui.applyLocale('zh-CN');
    applyStaticText(document, true);
    page.refreshTtsConfigText();
    expect(q('h1').textContent).toBe('TTS 语音配置');
    expect(q('#status-text').textContent).toBe('Fish 本地（高级）· 预设 nomi（未就绪则保持静默）');
  });
});
