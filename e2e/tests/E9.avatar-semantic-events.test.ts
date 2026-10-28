/**
 * E9 · 语义事件协议（docs/design/core-host-decoupling.md §10.5）跑在无界面宿主的真实内核上
 *
 * AI 与角色之间只传语义名，角色包的 mapping.json 在角色窗口里把它们翻译成资源；内核这一侧：
 * - AI → 角色：插件里的 `ctx.avatar`、工具 `avatar_gesture`、视图调的 `ai.avatar.*` 与内核服务（首次引导的
 *   `onboarding.mascot`）都经内核实例自己的事件总线发布契约事件 `avatar.event`，
 *   只推给看板娘窗口；资源名（`thumbs_up`）过不了线；
 * - 角色 → AI：看板娘窗口经 `ai.avatar.report` 报被摸 / 被点，插件里 `ctx.avatar.on('touched')` 收到，
 *   订阅了的窗口收到 `ai.avatar.touched`。
 */
import { ToolRegistryKey } from '@nomi-ai/bundle-ig-base';
import { AvatarKey, type AvatarService } from '@nomi-ai/bundle-ig-mascot/plugins';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startE2eCore, type E2eCore } from '../helpers/headlessCore';

const MASCOT = { surface: 'mascot', trusted: true } as const;

describe('E9 · semantic avatar events on the headless core', () => {
  let core: E2eCore;

  beforeEach(async () => {
    core = await startE2eCore();
  });
  afterEach(async () => {
    await core.stop();
  });

  function avatar(): AvatarService {
    const svc = core.plugin.inject(AvatarKey);
    if (!svc) throw new Error('ctx.avatar is not provided by the core');
    return svc;
  }

  it('AI side → character window: avatar.event carries semantic names only, to the mascot window', async () => {
    const mascot = core.openWindow(MASCOT);
    const chat = core.openWindow();
    const cues: unknown[] = [];
    const chatCues: unknown[] = [];
    mascot.api.on('avatar.event', (e) => cues.push(e));
    // 对话窗口不在 avatar.event 的订阅白名单里：订阅了也收不到
    chat.api.on('avatar.event', (e) => chatCues.push(e));
    await core.settle();

    // 插件里的 ctx.avatar（MascotIpcHostPlugin 接到内核的事件总线）
    await avatar().gesture('wave');
    await avatar().emotion('happy', 0.5);
    // 工具 avatar_gesture（模型调用的那条路）
    const tool = core.plugin.inject(ToolRegistryKey)?.get('avatar_gesture');
    expect(tool).toBeDefined();
    await tool!.execute({ name: 'thumbsUp' }, {} as never);
    // 视图调 ai.avatar.*（对话窗口）
    await chat.api.ai.avatar.activity({ name: 'thinking' });
    // 内核服务：首次引导让看板娘做个手势、等回复
    await chat.api.onboarding.mascot({ type: 'gesture', name: 'nod' });
    await chat.api.onboarding.mascot({ type: 'reply', phase: 'waiting' });
    await core.settle(30);

    expect(cues).toEqual([
      { type: 'gesture', name: 'wave' },
      { type: 'emotion', name: 'happy', weight: 0.5 },
      { type: 'gesture', name: 'thumbsUp' },
      { type: 'activity', name: 'thinking' },
      { type: 'gesture', name: 'nod' },
      { type: 'reply', phase: 'waiting' },
    ]);
    expect(chatCues).toEqual([]);
  });

  it('resource names do not cross the wire, unknown names are ignored', async () => {
    const mascot = core.openWindow(MASCOT);
    const chat = core.openWindow();
    const cues: unknown[] = [];
    mascot.api.on('avatar.event', (e) => cues.push(e));
    await core.settle();

    await expect(chat.api.ai.avatar.gesture({ name: 'thumbs_up' as never })).rejects.toMatchObject({
      code: 'BAD_INPUT',
    });
    await expect(
      chat.api.onboarding.mascot({ type: 'motion', name: 'nod' } as never),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    // 词表外的驼峰名过了 schema，由 ctx.avatar 忽略
    await chat.api.ai.avatar.gesture({ name: 'moonwalk' });
    await core.settle(30);
    expect(cues).toEqual([]);
  });

  it('character window → AI: touched reaches ctx.avatar and the subscribed windows', async () => {
    const mascot = core.openWindow(MASCOT);
    const chat = core.openWindow();
    const inPlugin: unknown[] = [];
    const off = avatar().on('touched', (p) => inPlugin.push(p));
    const atChat: unknown[] = [];
    chat.client.on('avatar:touched', (p) => atChat.push(p));
    await core.settle();

    await mascot.api.ai.avatar.report({ type: 'touched', hitbox: 'head' });
    await core.settle(30);
    off();

    expect(inPlugin).toEqual([expect.objectContaining({ hitbox: 'head', at: expect.any(Number) })]);
    expect(atChat).toEqual([expect.objectContaining({ hitbox: 'head' })]);
  });
});
