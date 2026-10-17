import {
  claimIpcChannel,
  getIpcChannelOwner,
  listIpcChannels,
  releaseIpcChannel,
  resetIpcChannelsForTest,
} from '../../../src/handlers/ipc/channelRegistry';

describe('IPC 通道全局注册表', () => {
  beforeEach(() => resetIpcChannelsForTest());

  it('重名通道由不同所有者认领时抛错，并指出先到者', () => {
    claimIpcChannel('save-voice-settings', 'ConfigIpcHandler');
    expect(() => claimIpcChannel('save-voice-settings', 'VoiceIpcHandler')).toThrow(
      /already registered by ConfigIpcHandler/,
    );
    expect(getIpcChannelOwner('save-voice-settings')).toBe('ConfigIpcHandler');
  });

  it('同一所有者重复认领幂等；释放后别人可以认领', () => {
    claimIpcChannel('a', 'X');
    claimIpcChannel('a', 'X');
    releaseIpcChannel('a', 'Y'); // 非所有者释放无效
    expect(listIpcChannels()).toEqual(['a']);
    releaseIpcChannel('a', 'X');
    expect(listIpcChannels()).toEqual([]);
    expect(() => claimIpcChannel('a', 'Y')).not.toThrow();
  });
});
