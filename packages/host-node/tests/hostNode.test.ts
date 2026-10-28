import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNodeHostPorts, NODE_HOST_CAPABILITIES, type NodeHostPorts } from '../src/index';

const made: NodeHostPorts[] = [];
const create = (...args: Parameters<typeof createNodeHostPorts>) => {
  const h = createNodeHostPorts(...args);
  made.push(h);
  return h;
};

afterEach(() => {
  for (const h of made.splice(0)) h.control.dispose();
});

describe('paths', () => {
  it('在临时目录下建好全部目录，dispose 后删除', () => {
    const { ports, control } = create();
    const all = [
      ports.paths.userData(),
      ports.paths.logs(),
      ports.paths.temp(),
      ports.paths.resources(),
      ports.paths.appPath(),
      ports.paths.home(),
      ports.paths.documents(),
    ];
    for (const p of all) {
      expect(p.startsWith(control.root)).toBe(true);
      expect(existsSync(p)).toBe(true);
    }
    expect(ports.paths.logs()).toBe(path.join(ports.paths.userData(), 'logs'));
    control.dispose();
    expect(existsSync(control.root)).toBe(false);
  });

  it('调用方给的 root 不会被删除；单个目录可覆盖', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'host-node-test-'));
    try {
      const custom = path.join(root, 'custom-home');
      const { ports, control } = create({ root, paths: { home: custom } });
      expect(ports.paths.home()).toBe(custom);
      expect(ports.paths.documents()).toBe(path.join(custom, 'Documents'));
      control.dispose();
      expect(existsSync(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('app', () => {
  it('有默认值，可覆盖', () => {
    expect(create().ports.app.isPackaged()).toBe(false);
    const { ports } = create({ app: { version: '9.9.9', locale: 'en-US', platform: 'linux' } });
    expect(ports.app.version()).toBe('9.9.9');
    expect(ports.app.locale()).toBe('en-US');
    expect(ports.app.platform()).toBe('linux');
  });
});

describe('secrets', () => {
  it('内存编码可往返，拒绝外来数据', () => {
    const { ports } = create();
    expect(ports.secrets.available()).toBe(true);
    expect(ports.secrets.backend()).toBe('memory');
    const c = ports.secrets.encrypt('sk-123');
    expect(c).toBeInstanceOf(Uint8Array);
    expect(ports.secrets.decrypt(c)).toBe('sk-123');
    expect(() => ports.secrets.decrypt(new TextEncoder().encode('plain'))).toThrow();
  });

  it('不可用时加解密都抛错', () => {
    const { ports, control } = create({ secretsAvailable: false });
    expect(ports.secrets.available()).toBe(false);
    expect(() => ports.secrets.encrypt('x')).toThrow();
    control.setSecretsAvailable(true);
    expect(ports.secrets.decrypt(ports.secrets.encrypt('x'))).toBe('x');
  });
});

describe('dialogs', () => {
  it('按顺序返回预设答案，空队列视为取消，并记录调用', async () => {
    const { ports, control } = create({
      dialogs: { pickDirectory: ['/a', null], pickFiles: [['/f1', '/f2']] },
    });
    control.queueDialog('saveFile', '/out.zip');
    expect(await ports.dialogs.pickDirectory({ title: 't', parent: 'focused' })).toBe('/a');
    expect(await ports.dialogs.pickDirectory()).toBeNull();
    expect(await ports.dialogs.pickDirectory()).toBeNull();
    expect(await ports.dialogs.pickFiles({ multiple: true })).toEqual(['/f1', '/f2']);
    expect(await ports.dialogs.pickFiles()).toEqual([]);
    expect(await ports.dialogs.saveFile({ defaultPath: 'x.zip' })).toBe('/out.zip');
    expect(await ports.dialogs.saveFile()).toBeNull();
    ports.dialogs.showError('boom', 'details');
    expect(control.dialogCalls).toHaveLength(8);
    expect(control.dialogCalls[0]).toEqual({
      kind: 'pickDirectory',
      opts: { title: 't', parent: 'focused' },
      answer: '/a',
    });
    expect(control.dialogCalls[7]).toEqual({
      kind: 'showError',
      title: 'boom',
      message: 'details',
    });
  });
});

describe('shell', () => {
  it('只记录调用；openPath 返回预设结果', async () => {
    const { ports, control } = create({
      openPathResult: (p) => (p === '/missing' ? 'not found' : ''),
    });
    await ports.shell.openExternal('https://example.com');
    expect(await ports.shell.openPath('/ok')).toBe('');
    expect(await ports.shell.openPath('/missing')).toBe('not found');
    ports.shell.showItemInFolder('/ok/file');
    expect(control.shellCalls).toEqual([
      { method: 'openExternal', target: 'https://example.com' },
      { method: 'openPath', target: '/ok' },
      { method: 'openPath', target: '/missing' },
      { method: 'showItemInFolder', target: '/ok/file' },
    ]);
  });
});

describe('clipboard / screenCapture', () => {
  it('剪贴板读写在内存里', async () => {
    const { ports, control } = create({ clipboard: { text: 'hi' } });
    expect(await ports.clipboard.readText()).toBe('hi');
    await ports.clipboard.writeText('bye');
    expect(await ports.clipboard.readText()).toBe('bye');
    expect(await ports.clipboard.readImage()).toBeNull();
    const image = { mime: 'image/png' as const, data: new Uint8Array([1]), width: 1, height: 1 };
    control.setClipboardImage(image);
    expect(await ports.clipboard.readImage()).toEqual(image);
  });

  it('没有预设截屏时 capture 抛错，有预设时返回', async () => {
    await expect(create().ports.screenCapture.capture()).rejects.toThrow();
    expect(await create().ports.screenCapture.listDisplays()).toEqual([]);
    const capture = vi.fn((o) => ({
      displayId: o.displayId ?? '1',
      mime: 'image/png' as const,
      data: new Uint8Array([0]),
      width: 1,
      height: 1,
      capturedAt: 1,
    }));
    const { ports } = create({ screen: { capture } });
    expect((await ports.screenCapture.capture({ displayId: '2' })).displayId).toBe('2');
  });
});

describe('power / lifecycle', () => {
  it('空闲时间可调，挂起 / 恢复事件可触发与退订', () => {
    const { ports, control } = create({ idleSeconds: 5 });
    expect(ports.power.idleSeconds()).toBe(5);
    control.setIdleSeconds(700);
    expect(ports.power.idleSeconds()).toBe(700);
    const onSuspend = vi.fn();
    const onResume = vi.fn();
    const off = ports.power.onSuspend(onSuspend);
    ports.power.onResume(onResume);
    control.emitSuspend();
    off();
    control.emitSuspend();
    control.emitResume();
    expect(onSuspend).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('before-quit 回调逐个等待，抛错不影响其余；quit / exit 只记录', async () => {
    const { ports, control } = create();
    await expect(ports.lifecycle.whenReady()).resolves.toBeUndefined();
    const order: string[] = [];
    ports.lifecycle.onBeforeQuit(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('a');
    });
    ports.lifecycle.onBeforeQuit(() => {
      throw new Error('x');
    });
    const off = ports.lifecycle.onBeforeQuit(() => void order.push('removed'));
    ports.lifecycle.onBeforeQuit(() => void order.push('c'));
    off();
    await control.runBeforeQuit();
    expect(order).toEqual(['a', 'c']);
    const onActivate = vi.fn();
    ports.lifecycle.onActivate(onActivate);
    control.emitActivate();
    expect(onActivate).toHaveBeenCalledOnce();
    ports.lifecycle.quit();
    expect(control.quitCount).toBe(1);
    expect(control.exitCode).toBeNull();
    ports.lifecycle.exit();
    expect(control.exitCode).toBe(0);
  });
});

describe('windows / capabilities', () => {
  it('记录调用并跟踪可见性', async () => {
    const { ports, control } = create();
    expect(ports.windows.isVisible('chat')).toBe(false);
    await ports.windows.open('chat', { route: 'providers' });
    await ports.windows.open('mascot');
    ports.windows.focus('chat');
    ports.windows.hide('mascot');
    expect(ports.windows.isVisible('chat')).toBe(true);
    expect(ports.windows.isVisible('mascot')).toBe(false);
    expect(control.visibleSurfaces()).toEqual(['chat']);
    expect(control.windowCalls).toEqual([
      { method: 'open', surface: 'chat', intent: { route: 'providers' } },
      { method: 'open', surface: 'mascot' },
      { method: 'focus', surface: 'chat' },
      { method: 'hide', surface: 'mascot' },
    ]);
  });

  it('能力默认全部关闭，可覆盖且只读', () => {
    expect(create().ports.capabilities).toEqual(NODE_HOST_CAPABILITIES);
    const { ports } = create({ capabilities: { tray: true } });
    expect(ports.capabilities.tray).toBe(true);
    expect(ports.capabilities.transparentWindow).toBe(false);
    expect(Object.isFrozen(ports.capabilities)).toBe(true);
  });
});
