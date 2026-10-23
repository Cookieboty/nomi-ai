jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');
jest.unmock('node:os');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  acpPromptParts,
  claudeContentBlocks,
  codexImageArgs,
  codexTurnInput,
  grokPromptJsonArgv,
  imageSupportFor,
  imageThumbsForMessage,
  modelNoVisionMessage,
  normalizeImages,
  stageImages,
  unsupportedImageMessage,
} from '../../../src/cli/promptImages';

describe('promptImages', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ).toString('base64');

  it('normalizes mime and drops invalid', () => {
    const out = normalizeImages([
      { mime: 'image/jpg', data: png, thumb: `data:image/jpeg;base64,${png}` },
      { mime: 'image/svg+xml', data: png },
      { mime: 'image/png', data: '' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.mime).toBe('image/jpeg');
  });

  it('reports dsh unsupported', () => {
    expect(imageSupportFor('dsh')).toBe('none');
    expect(imageSupportFor('claude')).toBe('full');
    expect(unsupportedImageMessage('dsh')).toMatch(/dsh/);
    // 不再让用户「换到 Claude / Codex…」：能不能看图看模型
    expect(unsupportedImageMessage('dsh')).not.toMatch(/Claude/);
    expect(modelNoVisionMessage('GPT-X')).toContain('GPT-X');
  });

  it('builds Claude / ACP / Codex / Grok payloads', () => {
    const imgs = normalizeImages([{ mime: 'image/png', data: png, width: 1, height: 1 }]);
    const blocks = claudeContentBlocks('hi', imgs);
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
    expect(blocks.some((b) => b.type === 'text' && b.text === 'hi')).toBe(true);

    const acp = acpPromptParts('hi', imgs);
    expect(acp.some((b) => b.type === 'image')).toBe(true);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-img-'));
    try {
      const staged = stageImages(dir, imgs);
      expect(fs.existsSync(staged[0]!.absPath)).toBe(true);
      const input = codexTurnInput('hi', staged);
      expect(input.some((x) => x.type === 'localImage')).toBe(true);
      expect(codexImageArgs(staged)).toEqual(['--image', staged[0]!.absPath]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }

    const argv = grokPromptJsonArgv('hi', imgs);
    expect(argv[0]).toBe('--prompt-json');
    const payload = JSON.parse(argv[1]!);
    expect(payload.content.some((c: { type: string }) => c.type === 'image')).toBe(true);
  });

  it('thumbs omit full base64 payload size concern via separate thumb field', () => {
    const imgs = normalizeImages([
      { mime: 'image/png', data: png, width: 2, height: 2, thumb: 'data:image/png;base64,aaa' },
    ]);
    expect(imageThumbsForMessage(imgs)[0]).toMatchObject({
      thumb: 'data:image/png;base64,aaa',
      width: 2,
      height: 2,
    });
  });
});
