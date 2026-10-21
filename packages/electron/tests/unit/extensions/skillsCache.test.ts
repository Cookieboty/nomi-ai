/**
 * 每条消息发送前都会取技能上下文：listSkills 结果缓存，只有技能文件夹 / SKILL.md 变化或应用内改动时才重新扫描。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ExtensionsService } from '../../../src/extensions/ExtensionsService';

let ud = '';
beforeEach(() => {
  ud = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-cache-'));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(ud, { recursive: true, force: true });
});

const make = () =>
  new ExtensionsService({
    root: path.join(ud, 'extensions'),
    skillsRoot: path.join(ud, 'skills'),
    logger: { info() {}, warn() {}, error() {} } as never,
    desktop: { audit: { append: jest.fn() } } as never,
  });

const md = (name: string, desc: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n\n正文\n`;

describe('listSkills cache', () => {
  it('second call does not re-read SKILL.md files', () => {
    const ext = make();
    const first = ext.listSkills();
    const read = jest.spyOn(fs, 'readFileSync');
    expect(ext.listSkills()).toBe(first);
    ext.skillsContext();
    expect(read).not.toHaveBeenCalled();
  });

  it('picks up an external edit / new skill folder', () => {
    const ext = make();
    const before = ext.listSkills().length;
    const dir = path.join(ud, 'skills', 'my-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md('my-skill', '第一版'));
    const list = ext.listSkills();
    expect(list).toHaveLength(before + 1);
    expect(list.find((s) => s.name === 'my-skill')?.description).toBe('第一版');
    // 外部改了 SKILL.md（大小变了）
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md('my-skill', '第二版，更长一些'));
    expect(ext.listSkills().find((s) => s.name === 'my-skill')?.description).toBe(
      '第二版，更长一些',
    );
  });

  it('in-app toggle invalidates the cache', () => {
    const ext = make();
    const dir = path.join(ud, 'skills', 'my-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md('my-skill', '说明'));
    expect(ext.listSkills().find((s) => s.name === 'my-skill')?.enabled).toBe(true);
    ext.toggleSkill('my-skill', false);
    expect(ext.listSkills().find((s) => s.name === 'my-skill')?.enabled).toBe(false);
  });
});
