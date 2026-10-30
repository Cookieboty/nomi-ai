/**
 * 旧版编程助手 Key 解密：经 secrets 端口（不再直接用 safeStorage），失败时退回明文 base64。
 */
import { legacyCliKeyDecryptor } from '../../../src/cli/legacyCliKey';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('legacyCliKeyDecryptor', () => {
  it('安全存储可用：按密文解密', () => {
    const decrypt = jest.fn((c: Uint8Array) => `plain:${Buffer.from(c).toString('utf8')}`);
    const dec = legacyCliKeyDecryptor({ available: () => true, decrypt });
    expect(dec(b64('cipher'))).toBe('plain:cipher');
    expect(Buffer.from(decrypt.mock.calls[0]![0]).toString('utf8')).toBe('cipher');
  });

  it('安全存储不可用：按明文 base64 读', () => {
    const decrypt = jest.fn();
    const dec = legacyCliKeyDecryptor({ available: () => false, decrypt });
    expect(dec(b64('sk-plain'))).toBe('sk-plain');
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('解密失败（旧格式没有加密标记）：退回明文 base64', () => {
    const dec = legacyCliKeyDecryptor({
      available: () => true,
      decrypt: () => {
        throw new Error('bad cipher');
      },
    });
    expect(dec(b64('sk-old'))).toBe('sk-old');
  });

  it('空串返回空串', () => {
    expect(legacyCliKeyDecryptor({ available: () => true, decrypt: () => 'x' })('')).toBe('');
  });
});
