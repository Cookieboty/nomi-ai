/**
 * 凭据加密落盘的策略（`enc:` 前缀、失败关闭、旧明文兼容）跑在宿主的 secrets 端口上。
 */
import {
  createSecretBox,
  safeStorageFromSecrets,
  SecretStorageUnavailableError,
} from '../../../src/security/secretStorage';
import { fakeSecrets } from '../helpers/featureHost';

describe('createSecretBox', () => {
  it('加密成 enc:<base64>，能解回来；无前缀视为旧明文', () => {
    const box = createSecretBox(fakeSecrets());
    expect(box.canEncrypt()).toBe(true);
    const enc = box.encrypt('k', 'unavailable');
    expect(enc).toBe(`enc:${Buffer.from('CIPHER<k>').toString('base64')}`);
    expect(box.decrypt(enc)).toBe('k');
    expect(box.decrypt('legacy-plain')).toBe('legacy-plain');
    expect(box.decrypt(undefined)).toBe('');
  });

  it('不可用或加密抛错时失败关闭；解密失败返回空串', () => {
    const state = { available: false, throws: false };
    const box = createSecretBox(fakeSecrets(state));
    expect(box.canEncrypt()).toBe(false);
    expect(() => box.encrypt('k', 'no keychain')).toThrow(SecretStorageUnavailableError);
    state.available = true;
    state.throws = true;
    expect(box.canEncrypt()).toBe(false);
    expect(() => box.encrypt('k', 'locked')).toThrow('locked');
    const broken = createSecretBox({
      available: () => true,
      encrypt: () => new Uint8Array(),
      decrypt: () => {
        throw new Error('bad');
      },
    });
    expect(broken.decrypt('enc:AAAA')).toBe('');
  });
});

describe('safeStorageFromSecrets', () => {
  it('把端口适配成 SafeStorageLike：Buffer 进出，后端名缺省为空串', () => {
    const port = fakeSecrets();
    const like = safeStorageFromSecrets(port);
    expect(like.isEncryptionAvailable()).toBe(true);
    expect(like.getSelectedStorageBackend?.()).toBe('');
    const buf = like.encryptString('token');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(like.decryptString(buf)).toBe('token');
    const basic = safeStorageFromSecrets({ ...port, backend: () => 'basic_text' });
    expect(basic.getSelectedStorageBackend?.()).toBe('basic_text');
  });
});
