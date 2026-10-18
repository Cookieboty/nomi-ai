jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CliHarnessService,
  materializeGeneratedImages,
  rewriteGeneratedImageLinks,
} from '../../../src/cli/CliHarnessService';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

describe('Grok generated image materialization', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nomi-grok-image-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('copies a session image and rewrites the relative Markdown link', () => {
    const source = path.join(root, '.grok', 'sessions', 'session-1', 'images', '1.jpg');
    const chatRoot = path.join(root, 'chat');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'jpeg bytes');

    const aliases = new Map<string, string>();
    materializeGeneratedImages(JSON.stringify({ path: source }), root, chatRoot, aliases);

    const url = aliases.get('images/1.jpg');
    expect(url).toMatch(/^chat-asset:\/\/images\/grok-[0-9a-f-]+\.jpg$/);
    const file = path.join(chatRoot, new URL(url!).hostname, new URL(url!).pathname.slice(1));
    expect(fs.readFileSync(file, 'utf8')).toBe('jpeg bytes');
    expect(rewriteGeneratedImageLinks('![cat](images/1.jpg)', aliases)).toBe(`![cat](${url})`);
  });

  it('does not copy paths outside the Grok session root', () => {
    const outside = path.join(root, 'outside.png');
    const chatRoot = path.join(root, 'chat');
    fs.writeFileSync(outside, 'private bytes');
    const aliases = new Map<string, string>();

    materializeGeneratedImages(JSON.stringify({ path: outside }), root, chatRoot, aliases);

    expect(aliases.size).toBe(0);
    expect(fs.existsSync(path.join(chatRoot, 'images'))).toBe(false);
  });

  it('migrates historical messages from tool trace paths', () => {
    const source = path.join(root, '.grok', 'sessions', 'session-2', 'images', '1.png');
    const harnessRoot = path.join(root, 'harness');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'png bytes');
    const harness = new CliHarnessService({
      root: harnessRoot,
      home: root,
      logger: { info() {}, warn() {} },
      defaultCwd: root,
    });
    const tab = harness.createTab({
      backend: 'grok',
      messages: [
        {
          id: 'old',
          role: 'assistant',
          content: '![cat](images/1.png)',
          timestamp: Date.now(),
          trace: [
            {
              type: 'tool',
              name: 'image_gen',
              status: 'done',
              output: JSON.stringify({ path: source }),
            },
          ],
        },
      ],
    });

    const messages = harness.tabMessages(tab.id);
    expect(messages[0]?.content).toMatch(/^!\[cat\]\(chat-asset:\/\/images\/grok-/);
    expect(fs.existsSync(path.join(root, 'chat', 'image-aliases.json'))).toBe(true);
    harness.dispose();
  });
});
