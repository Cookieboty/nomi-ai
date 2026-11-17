// @vitest-environment happy-dom
/**
 * 「新建会话后输入框打不了字」的前端成因（真机上还有一条：键盘焦点被隐藏的原生浏览器视图吃掉，
 * 由 apps/desktop-go/internal/shell/wailsshell 的 browserfocus_test.go / browserwindow_darwin.m 管）：
 *  1. 预览挡着（sendMismatch）时输入框被禁用，界面上却不说明原因；新建会话的同一帧里会话 id 为空 /
 *     cwd 还没解析、cwd 换了而预览没跟上，都曾被误判成「预览属于别的会话」——新会话绝不能被挡住；
 *     真挡住的时候输入框上方要有可见说明与「回到原会话」。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startupBrandIntro } from '../src/components/BrandIntro/state';
import { useResourcePreview } from '../src/hooks/useResourcePreview';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  startupBrandIntro.resetForTest();
});

type ScopeProps = { id: string; cwd: string | null };

const input = () => screen.getByTestId('chat-input') as HTMLTextAreaElement;
/** 对话列里的 testid（不含侧栏的新建菜单等浮层） */
const chatIds = () =>
  Array.from(
    document.querySelector('[data-testid="chat-column"]')?.querySelectorAll('[data-testid]') ?? [],
  ).map((el) => el.getAttribute('data-testid'));

/** 照 App 的用法搭最小页面：预览按会话分桶，输入框按 sendMismatch 禁用，说明读到 sendBlocked */
function Harness({ initial }: { initial: ScopeProps }) {
  const [scope, setScope] = React.useState<ScopeProps>(initial);
  const preview = useResourcePreview(
    { id: scope.id, cwd: scope.cwd, source: 'nomi' },
    { scoped: true },
  );
  return (
    <>
      <button onClick={() => preview.value.open('/w/note.txt', preview.value.scope)}>open</button>
      <button onClick={() => setScope({ id: 'nomi:2', cwd: '/w' })}>next-session</button>
      <button onClick={() => setScope({ id: 'nomi:1', cwd: '/w2' })}>change-cwd</button>
      <button onClick={() => setScope({ id: '', cwd: null })}>pending</button>
      <button onClick={() => setScope({ id: 'nomi:1', cwd: '/w' })}>cwd-resolved</button>
      <output data-testid="hint">
        {preview.sendBlocked
          ? `${preview.sendBlocked.scopeId}<-${preview.sendBlocked.previewId}`
          : ''}
      </output>
      <textarea data-testid="chat-input" disabled={preview.sendMismatch} />
    </>
  );
}

describe('composer blocked by a file preview', () => {
  it('a preview opened before the new session resolved its workspace follows the session', () => {
    // 新建会话：还没有工作目录时就开了文件，之后项目的 cwd 才到
    render(<Harness initial={{ id: 'nomi:1', cwd: null }} />);
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByText('cwd-resolved'));
    expect(input().disabled).toBe(false);
    expect(screen.getByTestId('hint').textContent).toBe('');
  });

  it('a brand-new session is never disabled by the preview of the session it came from', () => {
    render(<Harness initial={{ id: 'nomi:1', cwd: '/w' }} />);
    fireEvent.click(screen.getByText('open'));
    expect(input().disabled).toBe(false);
    fireEvent.click(screen.getByText('next-session'));
    expect(input().disabled).toBe(false);
    expect(screen.getByTestId('hint').textContent).toBe('');
    // 真能打字（不是只差 disabled 属性）
    fireEvent.change(input(), { target: { value: 'hi' } });
    expect(input().value).toBe('hi');
  });

  it('a session whose workspace moved under an open preview is disabled, with a visible reason', () => {
    render(<Harness initial={{ id: 'nomi:1', cwd: '/w' }} />);
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByText('change-cwd'));
    expect(input().disabled).toBe(true);
    // 同一个会话换了工作区：说明指向预览所属的会话 key
    expect(screen.getByTestId('hint').textContent).toBe('nomi:1<-nomi:1');
  });

  it('an unresolved session id or workspace is not treated as another session', () => {
    render(<Harness initial={{ id: 'nomi:1', cwd: '/w' }} />);
    fireEvent.click(screen.getByText('open'));
    // 新建会话的同一帧：会话 id 还是空、cwd 还没解析
    fireEvent.click(screen.getByText('pending'));
    expect(input().disabled).toBe(false);
    expect(screen.getByTestId('hint').textContent).toBe('');
  });
});

/** 全量 App：新建会话菜单里点「Nomi」（开发模式，只有 Codex 装好），之后输入框仍能打字且版面不变 */
vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

describe('new conversation from the sidebar', () => {
  it('keeps the composer typable after the CLI picker autofocused Nomi', async () => {
    const { default: App } = await import('../src/App');
    const { onboardingClient } = await import('../src/components/Onboarding/client');
    const { setChatMode, setConversationListView } = await import('../src/services/chatPrefs');
    const { installFakeApi } = await import('./helpers/fakeApi');
    onboardingClient.setPreparedDone(true);
    setChatMode('dev');
    setConversationListView('all');
    const fake = installFakeApi({
      'harness.state': () => ({
        backend: 'nomi',
        cwd: null,
        bins: { claude: null, codex: '/x', grok: null, dsh: null },
      }),
      'conversations.list': () => [],
      'conversations.current': () => null,
    });
    render(<App />);
    const before = (await screen.findByTestId('chat-input')) as HTMLTextAreaElement;
    const beforeIds = chatIds();
    fireEvent.click(screen.getByTestId('new-chat'));
    await fake.settle();
    fireEvent.click(await screen.findByTestId('new-chat-nomi'));
    await fake.settle();
    const after = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    expect(after.disabled).toBe(false);
    expect(chatIds()).toEqual(beforeIds);
    fireEvent.change(after, { target: { value: 'hello' } });
    expect(after).toBe(before);
    expect(after.value).toBe('hello');
  });
});
