jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');

describe('packaging: offline TTS model is downloaded on demand, not bundled', () => {
  it('electron-builder.yml has no tts-models extraResource but keeps sherpa natives unpacked', () => {
    const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
    expect(yml).not.toMatch(/^\s*-\s*from:\s*resources\/tts-models/m);
    expect(yml).not.toMatch(/^\s*to:\s*tts-models/m);
    expect(yml).toMatch(/sherpa-onnx/);
  });

  it('no prepackage step stages the model', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(`${name}: ${cmd}`).not.toMatch(/sync-tts-model/);
    }
    expect(fs.existsSync(path.join(root, 'scripts/sync-tts-model.mjs'))).toBe(false);
  });
});
