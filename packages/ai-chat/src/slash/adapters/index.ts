import type { ConversationBackend } from '../../types/chat';
import type { AdapterInput, SlashCommand } from '../types';

import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import { dshAdapter } from './dsh';
import { grokAdapter } from './grok';
import { nomiAdapter } from './nomi';

/** 每个后端一个 adapter：只回答「这个端有哪些命令、怎么接管」 */
export function adapterFor(backend: ConversationBackend, input: AdapterInput): SlashCommand[] {
  switch (backend) {
    case 'nomi':
      return nomiAdapter(input);
    case 'claude':
      return claudeAdapter(input);
    case 'codex':
      return codexAdapter(input);
    case 'grok':
      return grokAdapter(input);
    case 'dsh':
      return dshAdapter();
  }
}

/**
 * 重名时谁保留不带前缀的名字：Claude 文档规定 个人 > 项目；其它端沿用 OpenCode / Continue
 * 的惯例 项目 > 用户。插件命令本身已带「插件名:」前缀，不参与。
 */
export function scopeOrderFor(backend: ConversationBackend): Array<'project' | 'user' | 'plugin'> {
  return backend === 'claude' ? ['user', 'project', 'plugin'] : ['project', 'user', 'plugin'];
}
