/**
 * 通道快照锁 —— IPC_METHODS + CAPABILITY_CHANNELS + LEGACY_CHANNELS 三份白名单
 * 是 P6 阶段"IPC 表面"的**唯一真相**。任何改动都需要同步更新快照，防止意外新增/删除通道。
 */

import { describe, it, expect } from 'vitest';

import { CAPABILITY_CHANNELS } from '../src/CapabilityIpcServer';
import { IPC_METHODS, channelName } from '../src/channels';
import { LEGACY_CHANNELS } from '../src/legacy/AiChatCompat';

describe('IPC channel snapshot lock', () => {
  it('ai:<facade>:<method> whitelist', () => {
    const channels = IPC_METHODS.map(channelName).sort();
    expect(channels).toMatchInlineSnapshot(`
      [
        "ai:asr:list",
        "ai:asr:transcribe",
        "ai:avatar:driveLipSync",
        "ai:avatar:isAvailable",
        "ai:avatar:playMotion",
        "ai:avatar:setExpression",
        "ai:chat:abort",
        "ai:chat:agentStream",
        "ai:chat:regenerate",
        "ai:chat:sendMessage",
        "ai:chat:stream",
        "ai:facts:delete",
        "ai:facts:list",
        "ai:facts:put",
        "ai:sessions:create",
        "ai:sessions:delete",
        "ai:sessions:fork",
        "ai:sessions:get",
        "ai:sessions:list",
        "ai:sessions:rename",
        "ai:summaries:get",
        "ai:summaries:put",
        "ai:tools:confirm",
        "ai:tools:list",
        "ai:tools:setEnabled",
        "ai:tts:list",
        "ai:tts:listVoices",
        "ai:tts:stop",
        "ai:tts:stream",
        "ai:tts:synth",
        "ai:userProfile:export",
        "ai:userProfile:get",
        "ai:userProfile:import",
        "ai:userProfile:reset",
        "ai:userProfile:set",
      ]
    `);
  });

  it('capability channels whitelist', () => {
    expect([...CAPABILITY_CHANNELS].sort()).toMatchInlineSnapshot(`
      [
        "ai:clipboard:readImage",
        "ai:clipboard:readText",
        "ai:clipboard:writeText",
        "ai:screen:capture",
        "ai:screen:listDisplays",
      ]
    `);
  });

  it('legacy ai-chat:* channels whitelist', () => {
    expect([...LEGACY_CHANNELS].sort()).toMatchInlineSnapshot(`
      [
        "ai-chat:config:get",
        "ai-chat:config:update",
        "ai-chat:message:clearHistory",
        "ai-chat:message:getHistory",
        "ai-chat:message:send",
        "ai-chat:message:stream",
        "ai-chat:model:getAvailable",
      ]
    `);
  });
});
