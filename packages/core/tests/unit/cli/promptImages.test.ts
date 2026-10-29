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
  grokPromptFileArgv,
  imageSupportFor,
  imageThumbsForMessage,
  modelNoVisionMessage,
  inspectImages,
  rejectedImagesMessage,
  stageImages,
  unsupportedImageMessage,
} from '../../../src/cli/promptImages';

describe('promptImages', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ).toString('base64');

  it('normalizes mime and drops invalid', () => {
    const out = inspectImages([
      { mime: 'image/jpg', data: png, thumb: `data:image/jpeg;base64,${png}` },
      { mime: 'image/svg+xml', data: png },
      { mime: 'image/png', data: '' },
    ]).images;
    expect(out).toHaveLength(1);
    expect(out[0]!.mime).toBe('image/jpeg');
  });

  it('缺缩略图：小图用原图当缩略图（完整 base64），不再截断成坏图', () => {
    const [im] = inspectImages([{ mime: 'image/png', data: png }]).images;
    expect(im!.thumb).toBe(`data:image/png;base64,${png}`);
  });

  it('被拒绝的图片带原因，不再静默丢弃', () => {
    const big = 'A'.repeat(12_000_001);
    const noThumbBig = 'A'.repeat(700_000);
    const { images, rejected } = inspectImages([
      { mime: 'image/png', data: png },
      { mime: 'image/svg+xml', data: png },
      { mime: 'image/png', data: '' },
      { mime: 'image/png', data: big },
      { mime: 'image/png', data: noThumbBig },
      { mime: 'image/png', data: noThumbBig, thumb: 'data:image/png;base64,AAAA' },
    ]);
    expect(images).toHaveLength(2);
    expect(rejected.map((r) => [r.index, r.reason])).toEqual([
      [1, 'mime'],
      [2, 'empty'],
      [3, 'too-large'],
      [4, 'no-thumb'],
    ]);
    expect(rejectedImagesMessage(rejected)).toMatch(/4/);
  });

  it('超过张数上限也会被记录', () => {
    const raw = Array.from({ length: 3 }, () => ({ mime: 'image/png', data: png }));
    const { images, rejected } = inspectImages(raw, 2);
    expect(images).toHaveLength(2);
    expect(rejected).toEqual([{ index: 2, reason: 'over-max' }]);
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
    const imgs = inspectImages([{ mime: 'image/png', data: png, width: 1, height: 1 }]).images;
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

    const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-grok-'));
    try {
      const argv = grokPromptFileArgv(gdir, 'hi', imgs);
      // base64 不进 argv：只传文件路径（.json 按 content blocks 解析）
      expect(argv).toHaveLength(2);
      expect(argv[0]).toBe('--prompt-file');
      expect(argv[1]!.endsWith('.json')).toBe(true);
      expect(argv.join(' ')).not.toContain(png);
      const payload = JSON.parse(fs.readFileSync(argv[1]!, 'utf8'));
      expect(payload).toEqual(acpPromptParts('hi', imgs));
      expect(payload.some((c: { type: string }) => c.type === 'image')).toBe(true);
    } finally {
      fs.rmSync(gdir, { recursive: true, force: true });
    }
  });

  it('thumbs omit full base64 payload size concern via separate thumb field', () => {
    const imgs = inspectImages([
      { mime: 'image/png', data: png, width: 2, height: 2, thumb: 'data:image/png;base64,aaa' },
    ]).images;
    expect(imageThumbsForMessage(imgs)[0]).toMatchObject({
      thumb: 'data:image/png;base64,aaa',
      width: 2,
      height: 2,
    });
  });
});
