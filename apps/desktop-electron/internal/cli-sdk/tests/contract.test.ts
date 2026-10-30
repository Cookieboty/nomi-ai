import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  answerAllows,
  applyLaunchEnv,
  defineCliPlugin,
  effectiveCapabilities,
  ensurePrivateHome,
  validateManifest,
  writeLaunchFiles,
  type CliManifest,
} from '../src';

const manifest: CliManifest = {
  id: 'grok',
  apiVersion: 1,
  displayName: 'Grok',
  icon: 'grok.svg',
  binary: { names: ['grok'], versionArgs: ['--version'], versionPattern: '(\\d+\\.\\d+\\.\\d+)' },
  transport: 'acp',
  fallbackTransport: 'exec',
  ingress: 'responses',
  capabilities: {
    officialAccount: true,
    thirdParty: true,
    images: 'native',
    resume: true,
    permissionModes: [{ mode: 'plan', modeId: 'plan' }],
  },
  modelSwitch: 'inplace',
  versionGates: [{ range: '>=1.0.60', capabilities: { fork: true } }],
  clientSpec: {},
};

describe('manifest', () => {
  it('accepts a valid manifest and reports every problem of a bad one', () => {
    expect(validateManifest(manifest)).toEqual([]);
    const errs = validateManifest({
      ...manifest,
      id: 'Bad Id',
      apiVersion: 2,
      transport: 'grpc',
      binary: { names: [], versionArgs: [], versionPattern: '(' },
      capabilities: { images: 'yes', resume: 'y', permissionModes: [{ mode: 'god' }] },
      clientSpec: null,
    });
    expect(errs.join('\n')).toMatch(/id must match/);
    for (const re of [
      /apiVersion/,
      /transport/,
      /binary\.names/,
      /versionPattern/,
      /images/,
      /resume/,
      /permissionModes\[0\]/,
      /clientSpec/,
    ])
      expect(errs.some((e) => re.test(e))).toBe(true);
  });

  it('effective capabilities = declared ∩ version gates ∩ handshake', () => {
    const caps = effectiveCapabilities(manifest, {
      version: '1.0.67',
      inRange: (v, r) => r === '>=1.0.60' && v >= '1.0.60',
      handshake: { images: false, subagents: false },
    });
    expect(caps).toMatchObject({ fork: true, images: 'none', resume: true });
    // 握手不能打开清单没声明的能力
    expect(caps.subagents).toBeUndefined();
    expect(defineCliPlugin({ manifest }).manifest.id).toBe('grok');
  });

  it('answerAllows reads option kinds', () => {
    const options = [
      { id: 'a', kind: 'allow_once' },
      { id: 'r', kind: 'reject_always' },
    ];
    expect(answerAllows({ optionId: 'r' }, options)).toBe(false);
    expect(answerAllows({ optionId: 'a' }, options)).toBe(true);
    expect(answerAllows({ decision: 'cancel' })).toBeNull();
  });
});

describe('launch helpers', () => {
  it('applyLaunchEnv strips then overlays', () => {
    expect(
      applyLaunchEnv(
        { A: '1', XAI_API_KEY: 'k', PATH: '/bin' },
        { env: { GROK_HOME: '/h' }, strip: ['XAI_API_KEY'] },
      ),
    ).toEqual({ A: '1', PATH: '/bin', GROK_HOME: '/h' });
  });

  it('private HOME links shared entries back and keeps private ones out', () => {
    const user = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-user-'));
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-priv-')), 'home');
    fs.mkdirSync(path.join(user, 'sessions'));
    fs.writeFileSync(path.join(user, 'auth.json'), '{}');
    fs.writeFileSync(path.join(user, 'config.toml'), '');
    const problems = ensurePrivateHome({
      dir,
      userDir: user,
      shared: '.*',
      keepPrivate: ['^auth\\.json$', '\\.lock$'],
      platform: 'linux',
    });
    expect(problems).toEqual([]);
    expect(fs.lstatSync(path.join(dir, 'sessions')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(dir, 'auth.json'))).toBe(false);
    if (process.platform !== 'win32') expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    // 重复调用幂等
    expect(ensurePrivateHome({ dir, userDir: user, shared: '.*', keepPrivate: [] })).toEqual([]);
  });

  it('writeLaunchFiles writes 0600 files', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-files-')), 'a', 'cfg.toml');
    expect(writeLaunchFiles([{ path: f, content: 'x = 1' }])).toEqual([f]);
    expect(fs.readFileSync(f, 'utf8')).toBe('x = 1');
    if (process.platform !== 'win32') expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
});
