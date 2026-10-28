jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigService } from '../../../src/services/ConfigService';
import { fakeHostPorts } from '../helpers/fakeHostPorts';

describe('voiceSettings.enabled default (TTS model downloaded on demand)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-cfg-'));
  });

  it('new install: voice is off', async () => {
    const c = new ConfigService({ ports: fakeHostPorts({ userData: dir }) });
    await c.load();
    expect(c.get<{ enabled: boolean }>('voiceSettings').enabled).toBe(false);
  });

  it('existing user with voice on keeps it on (so the startup download kicks in)', async () => {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ voiceSettings: { enabled: true, volume: 0.5 } }),
    );
    const c = new ConfigService({ ports: fakeHostPorts({ userData: dir }) });
    await c.load();
    expect(c.get<{ enabled: boolean; volume: number }>('voiceSettings')).toMatchObject({
      enabled: true,
      volume: 0.5,
    });
  });

  it('existing user who had turned voice off stays off', async () => {
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ voiceSettings: { enabled: false } }),
    );
    const c = new ConfigService({ ports: fakeHostPorts({ userData: dir }) });
    await c.load();
    expect(c.get<{ enabled: boolean }>('voiceSettings').enabled).toBe(false);
  });
});
