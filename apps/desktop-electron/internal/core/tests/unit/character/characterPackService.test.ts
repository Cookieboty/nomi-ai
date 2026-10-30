/**
 * CharacterPackService.reload reads every directory from host ports (userData, resources,
 * appPath, isPackaged); no electron import.
 */
jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { repoPath } from '@nomi-ai/repo-paths';

import { CharacterPackService } from '../../../src/character/CharacterPackService';
import { fakeHostPorts } from '../helpers/fakeHostPorts';

// 未打包时的 appPath 在 apps/<应用>，内置角色包按它往上两级找 characters/。用一个没构建过的目录，
// 免得 apps/desktop-electron/dist/renderer/character（构建产物）先被找到
const ELECTRON_PKG = repoPath('apps/unbuilt-app');
const NOMI = repoPath('characters/nomi');
const TEST_DUMMY = repoPath('characters/test-dummy');

describe('CharacterPackService.reload via host ports', () => {
  let userData: string;
  let resources: string;
  const prevPack = process.env.CHARACTER_PACK;
  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-ud-'));
    resources = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-res-'));
    delete process.env.CHARACTER_PACK;
  });
  afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(resources, { recursive: true, force: true });
    if (prevPack === undefined) delete process.env.CHARACTER_PACK;
    else process.env.CHARACTER_PACK = prevPack;
  });

  it('finds the built-in pack from the unpacked app path when no overlay exists', () => {
    const svc = new CharacterPackService({
      ports: fakeHostPorts({ userData, resources, appPath: ELECTRON_PKG, packaged: false }),
    });
    const warn = jest.fn();
    svc.reload({ info: jest.fn(), warn });
    expect(svc.getResolved().source).toBe('builtin');
    expect(svc.getBuiltin()?.root).toBe(NOMI);
    expect(warn).not.toHaveBeenCalledWith('character-pack: built-in pack not found');
  });

  it('warns when no built-in pack exists under the given app path', () => {
    const svc = new CharacterPackService({
      ports: fakeHostPorts({ userData, resources, appPath: resources, packaged: true }),
    });
    const warn = jest.fn();
    svc.reload({ info: jest.fn(), warn });
    expect(warn).toHaveBeenCalledWith('character-pack: built-in pack not found');
  });

  it('uses the built-in pack the host chose and ignores CHARACTER_PACK', () => {
    process.env.CHARACTER_PACK = 'characters/nomi';
    const svc = new CharacterPackService({
      ports: fakeHostPorts({ userData, resources, appPath: ELECTRON_PKG, packaged: false }),
      builtinPackDir: TEST_DUMMY,
    });
    svc.reload({ info: jest.fn(), warn: jest.fn() });
    expect(svc.getResolved().source).toBe('builtin');
    expect(svc.getBuiltin()?.root).toBe(TEST_DUMMY);
    expect(svc.getBuiltin()?.manifest?.id).toBe('test-dummy');
  });

  it('builtinPackDir: null means no built-in pack, whatever the app path holds', () => {
    const svc = new CharacterPackService({
      ports: fakeHostPorts({ userData, resources, appPath: ELECTRON_PKG, packaged: false }),
      builtinPackDir: null,
    });
    const warn = jest.fn();
    svc.reload({ info: jest.fn(), warn });
    expect(svc.getBuiltin()).toBeNull();
    expect(warn).toHaveBeenCalledWith('character-pack: built-in pack not found');
  });
});
