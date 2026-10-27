import { guardOutboundMessages, type SendVerdict } from '../../../src/desktop/outboundGuard';

const FILE = '<attached-file name="a.txt" path="/tmp/a.txt">\nNOMI_SECRET_BODY\n</attached-file>';
const PATH_ONLY = '<attached-file name="b.bin" path="/tmp/b.bin" />';
const CLI = '<cli-output>\nnote\nDELEGATE_BODY\n</cli-output>';

function checker(v: SendVerdict) {
  const calls: string[] = [];
  return { calls, check: async (what: string) => (calls.push(what), v) };
}

describe('guardOutboundMessages', () => {
  it('blocks a new text attachment when local-only is on', async () => {
    const c = checker('local_only');
    const msgs = [{ role: 'user', content: `look\n\n${FILE}` }];
    await expect(guardOutboundMessages(msgs, c.check)).rejects.toThrow();
    expect(c.calls).toHaveLength(1);
  });

  it('blocks a new text attachment when the user declines the cloud notice', async () => {
    const c = checker('user_denied');
    await expect(
      guardOutboundMessages([{ role: 'user', content: FILE }], c.check),
    ).rejects.toThrow();
  });

  it('allows attachments once the receiver is allowed, without touching content', async () => {
    const c = checker(null);
    const msgs = [{ role: 'user', content: FILE }];
    await guardOutboundMessages(msgs, c.check);
    expect(msgs[0]!.content).toBe(FILE);
  });

  it('path-only attachments and plain text need no check', async () => {
    const c = checker('local_only');
    const msgs = [
      { role: 'assistant', content: 'hello <cli-output' },
      { role: 'user', content: `typed text\n\n${PATH_ONLY}` },
    ];
    await guardOutboundMessages(msgs, c.check);
    expect(c.calls).toHaveLength(0);
    expect(msgs[1]!.content).toContain(PATH_ONLY);
  });

  it('redacts history attachment bodies and delegate reports instead of failing (#117)', async () => {
    const c = checker('local_only');
    const msgs = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: `old\n\n${FILE}\n\n${PATH_ONLY}` },
      { role: 'assistant', content: `done: ${CLI}` },
      { role: 'user', content: 'next question' },
    ];
    await guardOutboundMessages(msgs, c.check);
    const all = msgs.map((m) => m.content).join('\n');
    expect(all).not.toContain('NOMI_SECRET_BODY');
    expect(all).not.toContain('DELEGATE_BODY');
    expect(msgs[1]!.content).toContain('<attached-file name="a.txt" path="/tmp/a.txt">');
    expect(msgs[1]!.content).toContain(PATH_ONLY);
    expect(msgs[2]!.content).toMatch(/^done: <cli-output>\n.+\n<\/cli-output>$/);
    // 每类内容只问一次
    expect(c.calls).toHaveLength(2);
  });

  it('keeps history content when allowed', async () => {
    const c = checker(null);
    const msgs = [
      { role: 'assistant', content: CLI },
      { role: 'user', content: 'q' },
    ];
    await guardOutboundMessages(msgs, c.check);
    expect(msgs[0]!.content).toBe(CLI);
  });
});
