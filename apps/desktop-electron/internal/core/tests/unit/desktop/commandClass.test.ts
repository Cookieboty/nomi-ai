jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';

import { repoPath } from '@nomi-ai/repo-paths';

import { classifyCommand } from '../../../src/desktop/commandClass';

// 用例与 Go 版共用（apps/desktop-go/internal/core/desktop/command_class_test.go）
const fixture = repoPath('apps/desktop-go/internal/core/desktop/testdata/command-class.json');

describe('classifyCommand', () => {
  const { cases } = JSON.parse(fs.readFileSync(fixture, 'utf8')) as {
    cases: { command: string; class: string | null }[];
  };
  it.each(cases.map((c) => [c.command, c.class]))('%s → %s', (command, cls) => {
    expect(classifyCommand(command)).toBe(cls);
  });
});
