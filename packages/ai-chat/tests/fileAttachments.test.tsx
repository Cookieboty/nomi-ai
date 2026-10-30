// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UserMessage } from '../src/components/Conversation/Messages';
import { MessageInput } from '../src/components/MessageInput';
import {
  MAX_TEXT_BYTES,
  fileAttachmentFrom,
  joinFileAttachments,
  splitFileAttachments,
  type FileAttachment,
} from '../src/services/fileAttachments';

vi.mock('../src/contexts/AiChatContext', () => ({
  useAiChat: () => ({
    state: { messages: [], isLoading: false, streaming: false },
    actions: { stopGeneration: vi.fn(), sendStreamMessage: vi.fn(), askKnowledge: vi.fn() },
  }),
}));

const w = window as unknown as { nomiHost?: unknown };
const bridge = () => {
  w.nomiHost = { pathForFile: (f: File) => `/tmp/${f.name}` };
};

afterEach(() => {
  cleanup();
  delete w.nomiHost;
});

const att = (over: Partial<FileAttachment>): FileAttachment => ({
  id: 'x',
  name: 'a.txt',
  path: '/tmp/a.txt',
  size: 1,
  ...over,
});

describe('fileAttachments 序列化', () => {
  it('正文 + 附件拼起来再拆开，内容、路径、特殊字符都还原', () => {
    const files = [
      att({ name: 'say "hi" & <b>.md', path: '/My Docs/say.md', text: 'x </attached-file> y' }),
      att({ name: 'b.pdf', path: '/tmp/b.pdf' }),
    ];
    const full = joinFileAttachments('看一下', files);
    expect(full.startsWith('看一下\n\n<attached-file name=')).toBe(true);
    const back = splitFileAttachments(full);
    expect(back.text).toBe('看一下');
    expect(back.files.map(({ name, path, text }) => ({ name, path, text }))).toEqual([
      { name: 'say "hi" & <b>.md', path: '/My Docs/say.md', text: 'x </attached-file> y' },
      { name: 'b.pdf', path: '/tmp/b.pdf', text: undefined },
    ]);
  });

  it('没有附件的消息原样返回', () => {
    expect(splitFileAttachments('普通消息')).toEqual({ text: '普通消息', files: [] });
  });
});

describe('fileAttachmentFrom', () => {
  it('小文本文件带内容，二进制只带路径', async () => {
    bridge();
    const txt = await fileAttachmentFrom(new File(['hello'], 'a.txt'));
    expect(txt).toMatchObject({ name: 'a.txt', path: '/tmp/a.txt', text: 'hello' });
    const bin = await fileAttachmentFrom(new File([new Uint8Array([0xff, 0xfe, 0x00])], 'b.bin'));
    expect(bin).toMatchObject({ path: '/tmp/b.bin' });
    expect(bin?.text).toBeUndefined();
  });

  it('超过大小上限的文本只带路径', async () => {
    bridge();
    const big = await fileAttachmentFrom(new File(['a'.repeat(MAX_TEXT_BYTES + 1)], 'big.log'));
    expect(big?.text).toBeUndefined();
  });

  it('没有桥又读不出文本的文件丢弃', async () => {
    expect(await fileAttachmentFrom(new File([new Uint8Array([0])], 'b.bin'))).toBeNull();
  });
});

describe('拖入文件', () => {
  it('输入框显示文件卡片，发送时内容拼在正文后面', async () => {
    bridge();
    const onSend = vi.fn();
    const r = render(<MessageInput onSend={onSend} busyOverride={false} />);
    const file = new File(['const a = 1;'], 'app.ts', { type: 'text/plain' });
    fireEvent.drop(window, { dataTransfer: { types: ['Files'], files: [file] } });
    await waitFor(() => expect(r.getByTestId('file-chip').textContent).toContain('app.ts'));
    fireEvent.change(r.getByTestId('chat-input'), { target: { value: '解释一下' } });
    fireEvent.click(r.getByTestId('send-button'));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const sent = onSend.mock.calls[0]![0] as string;
    expect(splitFileAttachments(sent)).toMatchObject({
      text: '解释一下',
      files: [{ name: 'app.ts', path: '/tmp/app.ts', text: 'const a = 1;' }],
    });
    expect(r.queryByTestId('file-chip')).toBeNull();
  });

  it('已发送的用户消息把附件画成卡片，气泡只显示文字', () => {
    const text = joinFileAttachments('解释一下', [att({ name: 'app.ts', text: 'x' })]);
    const r = render(
      <UserMessage message={{ id: 'u1', role: 'user', text, at: 0 } as never} canEdit={false} />,
    );
    expect(r.getByTestId('message-files').textContent).toContain('app.ts');
    expect(r.getByTestId('msg-user').textContent).not.toContain('attached-file');
    fireEvent.click(r.getByTestId('file-chip').querySelector('button')!);
    expect(r.getByTestId('file-preview')).toBeTruthy();
  });
});
