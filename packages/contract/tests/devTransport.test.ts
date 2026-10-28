import { describe, expect, it } from 'vitest';

import {
  NOMI_DEV_TOKEN_STORAGE_KEY,
  resolveDevTransport,
  type DevTokenSource,
} from '../src/app/index';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const URL_ = 'ws://127.0.0.1:4567';

function source(hash: string, stored?: string) {
  const store = new Map<string, string>(stored ? [[NOMI_DEV_TOKEN_STORAGE_KEY, stored]] : []);
  const replaced: string[] = [];
  const src: DevTokenSource = {
    hash,
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
    },
    replaceFragment: (rest) => void replaced.push(rest),
  };
  return { src, store, replaced };
}

describe('resolveDevTransport（dev:web 的 token 不进页面 HTML）', () => {
  it('注入的全局只有地址：token 带在全局里也不用', () => {
    const { src } = source('');
    expect(resolveDevTransport({ url: URL_, token: TOKEN }, src)).toBeNull();
  });

  it('片段里的 token：存进 sessionStorage，并从地址栏抹掉（保留别的片段参数）', () => {
    const { src, store, replaced } = source(`#nomi-token=${TOKEN}&x=1`);
    expect(resolveDevTransport({ url: URL_ }, src)).toEqual({ url: URL_, token: TOKEN });
    expect(store.get(NOMI_DEV_TOKEN_STORAGE_KEY)).toBe(TOKEN);
    expect(replaced).toEqual(['x=1']);
  });

  it('刷新页面（片段已抹掉）用 sessionStorage 里的', () => {
    const { src, replaced } = source('', TOKEN);
    expect(resolveDevTransport({ url: URL_ }, src)).toEqual({ url: URL_, token: TOKEN });
    expect(replaced).toEqual([]);
  });

  it('格式不对的 token 也从地址栏抹掉，但不用、不存', () => {
    const { src, store, replaced } = source('#nomi-token=short');
    expect(resolveDevTransport({ url: URL_ }, src)).toBeNull();
    expect(store.size).toBe(0);
    expect(replaced).toEqual(['']);
  });

  it('没有注入地址 / sessionStorage 不可用', () => {
    expect(resolveDevTransport(undefined, source(`#nomi-token=${TOKEN}`).src)).toBeNull();
    const src: DevTokenSource = {
      hash: `#nomi-token=${TOKEN}`,
      storage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
      replaceFragment: () => undefined,
    };
    expect(resolveDevTransport({ url: URL_ }, src)).toEqual({ url: URL_, token: TOKEN });
  });
});
