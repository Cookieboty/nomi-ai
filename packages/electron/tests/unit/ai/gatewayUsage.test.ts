jest.mock('@nomi-ai/ai-runtime', () => ({ GATEWAY_PROVIDER_ID: 'nomi-gateway' }));

import { splitGatewayUsage } from '../../../src/ai/gatewayUsage';

describe('usage of chats routed through the gateway', () => {
  it('splits provider/model back into the real provider and model', () => {
    expect(splitGatewayUsage('nomi-gateway', 'deepseek/deepseek-v4-pro')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });
    // 模型名本身含 / 的只拆第一段
    expect(splitGatewayUsage('nomi-gateway', 'amux/anthropic/claude-opus')).toEqual({
      provider: 'amux',
      model: 'anthropic/claude-opus',
    });
    expect(splitGatewayUsage('p-1', 'a/b')).toEqual({ provider: 'p-1', model: 'a/b' });
    expect(splitGatewayUsage('nomi-gateway', 'bare')).toEqual({
      provider: 'nomi-gateway',
      model: 'bare',
    });
  });
});
