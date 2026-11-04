import { describe, expect, it, vi } from 'vitest';

import { maybeSmartTitleCliTab } from '../src/services/cliSmartTitle';

describe('maybeSmartTitleCliTab', () => {
  it('sends no title request when smart titles are turned off in privacy settings', async () => {
    const complete = vi.fn(async () => 'Auth fix');
    const apply = vi.fn();
    await maybeSmartTitleCliTab({
      tab: { id: 't0', source: 'thirdParty', modelOverride: 'acme/cool-model', backend: 'codex' },
      userText: 'fix authentication bug',
      complete,
      applyAutoTitle: apply,
      enabled: () => false,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('skips LLM for official tabs without a gateway model ref', async () => {
    const complete = vi.fn();
    const apply = vi.fn();
    await maybeSmartTitleCliTab({
      tab: { id: 't1', source: 'official', modelOverride: 'gpt-5', backend: 'codex' },
      userText: 'fix auth',
      complete,
      applyAutoTitle: apply,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('runs LLM for thirdParty tabs and applies title', async () => {
    const complete = vi.fn(async () => 'Auth fix');
    const apply = vi.fn(async () => ({ id: 't1', title: 'Auth fix' }));
    await maybeSmartTitleCliTab({
      tab: {
        id: 't1',
        source: 'thirdParty',
        modelOverride: 'acme/cool-model',
        backend: 'codex',
      },
      userText: 'fix authentication bug',
      complete,
      applyAutoTitle: apply,
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith('t1', 'Auth fix');
  });

  it('uses lastServedRef when thirdParty has no modelOverride', async () => {
    const complete = vi.fn(async () => 'Parser');
    const apply = vi.fn(async () => ({ id: 't2', title: 'Parser' }));
    await maybeSmartTitleCliTab({
      tab: {
        id: 't2',
        source: 'thirdParty',
        modelOverride: null,
        lastServedRef: 'acme/cool-model',
        backend: 'codex',
      },
      userText: 'write a parser',
      complete,
      applyAutoTitle: apply,
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith('t2', 'Parser');
  });

  it('skips apply when generateSmartTitle returns null', async () => {
    const complete = vi.fn(async () => '');
    const apply = vi.fn();
    await maybeSmartTitleCliTab({
      tab: {
        id: 't3',
        source: 'thirdParty',
        modelOverride: 'acme/cool-model',
        backend: 'codex',
      },
      userText: 'something',
      complete,
      applyAutoTitle: apply,
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });
});
