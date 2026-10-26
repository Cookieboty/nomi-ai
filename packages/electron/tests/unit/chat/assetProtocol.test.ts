// 全局 setup 把 fs / path 换成了 mock；这里需要真实文件系统（realpath / resolve）
jest.unmock('fs');
jest.unmock('path');

import { promises as fsp, mkdtempSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CHAT_ASSET_SCHEME,
  chatAssetMimeFor,
  resolveChatAssetUrl,
} from '../../../src/chat/assetProtocol';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'chat-asset-'));

async function makeRoot(withOutsideFile = false) {
  const root = tmp();
  const images = path.join(root, 'images');
  await fsp.mkdir(images, { recursive: true });
  await fsp.writeFile(path.join(images, 'hello.png'), Buffer.from([0]));
  await fsp.mkdir(path.join(images, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(images, 'sub', 'ok.webp'), Buffer.from([0]));
  if (withOutsideFile) await fsp.writeFile(path.join(root, 'secret.png'), Buffer.from([0]));
  return { root, images };
}

describe('CHAT_ASSET_SCHEME', () => {
  it('exposes a stable scheme name', () => {
    expect(CHAT_ASSET_SCHEME).toBe('chat-asset');
  });
});

describe('chatAssetMimeFor', () => {
  it('maps common image extensions, unknown falls back to octet-stream', () => {
    expect(chatAssetMimeFor('a.png')).toBe('image/png');
    expect(chatAssetMimeFor('a.PNG')).toBe('image/png');
    expect(chatAssetMimeFor('a.jpg')).toBe('image/jpeg');
    expect(chatAssetMimeFor('a.jpeg')).toBe('image/jpeg');
    expect(chatAssetMimeFor('a.webp')).toBe('image/webp');
    expect(chatAssetMimeFor('a.gif')).toBe('image/gif');
    expect(chatAssetMimeFor('a.bmp')).toBe('application/octet-stream');
    expect(chatAssetMimeFor('noext')).toBe('application/octet-stream');
  });
});

describe('resolveChatAssetUrl · AREA 白名单', () => {
  it('serves local presets while rejecting malformed URL encoding', async () => {
    const { root } = await makeRoot();
    const preset = path.join(root, 'presets', 'background.jpg');
    await fsp.mkdir(path.dirname(preset));
    await fsp.writeFile(preset, Buffer.from([0]));
    expect(await resolveChatAssetUrl(root, 'chat-asset://presets/background.jpg')).toBe(
      await fsp.realpath(preset),
    );
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/%ZZ.png')).toBeNull();
    await fsp.rm(root, { recursive: true });
  });
  it('只放行 images AREA；其它 host 一律拒绝', async () => {
    const { root } = await makeRoot();
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/hello.png')).toMatch(/hello\.png$/);
    expect(await resolveChatAssetUrl(root, 'chat-asset://generated/hello.png')).toBeNull();
    expect(await resolveChatAssetUrl(root, 'chat-asset://uploads/hello.png')).toBeNull();
    expect(await resolveChatAssetUrl(root, 'chat-asset:///hello.png')).toBeNull();
  });

  it('只接受 chat-asset: 协议；http / file / cdmodel 均拒绝', async () => {
    const { root } = await makeRoot();
    expect(await resolveChatAssetUrl(root, 'http://images/hello.png')).toBeNull();
    expect(await resolveChatAssetUrl(root, 'file:///tmp/hello.png')).toBeNull();
    expect(await resolveChatAssetUrl(root, 'cdmodel://images/hello.png')).toBeNull();
    expect(await resolveChatAssetUrl(root, 'not a url')).toBeNull();
  });
});

describe('resolveChatAssetUrl · 扩展名白名单', () => {
  it('接受常见图片扩展名，拒绝其它扩展名与无扩展名', async () => {
    const { root, images } = await makeRoot();
    await fsp.writeFile(path.join(images, 'a.jpg'), Buffer.from([0]));
    await fsp.writeFile(path.join(images, 'a.jpeg'), Buffer.from([0]));
    await fsp.writeFile(path.join(images, 'a.gif'), Buffer.from([0]));
    await fsp.writeFile(path.join(images, 'a.svg'), Buffer.from([0]));
    await fsp.writeFile(path.join(images, 'a.exe'), Buffer.from([0]));
    await fsp.writeFile(path.join(images, 'noext'), Buffer.from([0]));

    expect(await resolveChatAssetUrl(root, 'chat-asset://images/hello.png')).toMatch(/hello\.png$/);
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/a.jpg')).toMatch(/a\.jpg$/);
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/a.jpeg')).toMatch(/a\.jpeg$/);
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/a.gif')).toMatch(/a\.gif$/);
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/sub/ok.webp')).toMatch(/ok\.webp$/);

    expect(await resolveChatAssetUrl(root, 'chat-asset://images/a.svg')).toBeNull();
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/a.exe')).toBeNull();
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/noext')).toBeNull();
  });
});

describe('resolveChatAssetUrl · 路径穿越防御', () => {
  it('拒绝 .. 直接穿越、percent-encoded 穿越、空段与 NUL 字节', async () => {
    const { root } = await makeRoot(true);
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/../secret.png')).toBeNull();
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/%2e%2e/secret.png')).toBeNull();
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/sub/../../secret.png')).toBeNull();
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/sub//ok.webp')).toBeNull();
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/\u0000.png')).toBeNull();
  });

  it('文件不存在时返回 null', async () => {
    const { root } = await makeRoot();
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/missing.png')).toBeNull();
  });
});

describe('resolveChatAssetUrl · realpath 防符号链接逃逸', () => {
  it('软链到 AREA 外的文件时拒绝', async () => {
    const { root, images } = await makeRoot(true);
    const linkPath = path.join(images, 'escape.png');
    try {
      symlinkSync(path.join(root, 'secret.png'), linkPath, 'file');
    } catch (e) {
      // Windows 普通用户没有建立符号链接权限时跳过
      const msg = e instanceof Error ? e.message : String(e);
      if (/EPERM|operation not permitted/i.test(msg)) {
        return;
      }
      throw e;
    }
    expect(await resolveChatAssetUrl(root, 'chat-asset://images/escape.png')).toBeNull();
  });

  it('AREA 根本身是软链但指向允许区域时放行', async () => {
    const realImages = path.join(tmp(), 'real-images');
    await fsp.mkdir(realImages, { recursive: true });
    await fsp.writeFile(path.join(realImages, 'a.png'), Buffer.from([0]));
    const root = tmp();
    try {
      symlinkSync(realImages, path.join(root, 'images'), 'dir');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/EPERM|operation not permitted/i.test(msg)) {
        return;
      }
      throw e;
    }
    const resolved = await resolveChatAssetUrl(root, 'chat-asset://images/a.png');
    expect(resolved).toMatch(/real-images[\\/]+a\.png$/);
  });
});
