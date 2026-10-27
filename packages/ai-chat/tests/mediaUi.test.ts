import { t } from '@nomi-ai/ui';
import { describe, expect, it } from 'vitest';

import {
  pruneSelection,
  selectAllOrNone,
  toggleSelection,
} from '../src/components/Media/AssetLibrary';
import { pillLabel } from '../src/components/Media/MediaSessionPill';
import {
  choiceProviders,
  originalOf,
  rememberOriginal,
  usablePairs,
  type MediaState,
} from '../src/services/mediaClient';

const state = {
  schemaVersion: 1,
  models: [{ id: 'm1', name: 'Model One' }],
  marks: [],
  providers: [
    { id: 'p1', name: 'Prov A', enabled: true, hasKey: true },
    { id: 'p2', name: 'Prov B', enabled: true, hasKey: false },
    { id: 'p3', name: 'Prov C', enabled: false, hasKey: true },
  ],
  bindings: [
    { modelId: 'm1', providerRef: 'p1', enabled: true },
    { modelId: 'm1', providerRef: 'p2', enabled: true },
    { modelId: 'm1', providerRef: 'p3', enabled: true },
    { modelId: 'm2', providerRef: 'p1', enabled: false },
  ],
  prefs: {},
  localOnly: false,
} as unknown as MediaState;

describe('素材库多选', () => {
  it('toggle 增删、不改原集合', () => {
    const a = new Set<string>();
    const b = toggleSelection(a, 'x');
    expect([...b]).toEqual(['x']);
    expect(a.size).toBe(0);
    expect(toggleSelection(b, 'x').size).toBe(0);
  });
  it('全选 / 已全选时清空', () => {
    expect([...selectAllOrNone(new Set(['a']), ['a', 'b'])]).toEqual(['a', 'b']);
    expect(selectAllOrNone(new Set(['a', 'b']), ['a', 'b']).size).toBe(0);
    expect(selectAllOrNone(new Set(), []).size).toBe(0);
  });
  it('列表刷新后剔除已删除项', () => {
    expect([...pruneSelection(new Set(['a', 'gone']), ['a', 'b'])]).toEqual(['a']);
  });
});

describe('会话生图模型', () => {
  it('只列已启用、供应商已启用且有 Key 的组合', () => {
    expect(usablePairs(state)).toEqual([{ modelId: 'm1', providerRef: 'p1' }]);
    expect(usablePairs(null)).toEqual([]);
  });
  it('pill 文案区分默认 / 本会话覆盖 / 未配置', () => {
    const c = { modelId: 'm1', providerRef: 'p1' };
    // 与词典是否加载无关：和 t() 的结果逐项对比
    const def = pillLabel(state, { choice: c, override: false });
    const ovr = pillLabel(state, { choice: c, override: true });
    expect(def).toBe(t('ui.media.session-pill', 'Model One', 'Prov A'));
    expect(ovr).toBe(def + t('ui.media.session-scope'));
    expect(pillLabel(state, { choice: null, override: false })).toBe(
      t('ui.media.session-unconfigured'),
    );
    expect(pillLabel(state, null)).toBe(t('ui.media.session-unconfigured'));
  });
});

describe('上传图原图登记', () => {
  it('按缩略图取回原图 data URL；未登记返回 null（不拿缩略图顶替）', () => {
    rememberOriginal('data:thumb1', 'image/png', 'QUJD');
    expect(originalOf('data:thumb1')).toBe('data:image/png;base64,QUJD');
    expect(originalOf('data:unknown')).toBeNull();
  });
  it('超过上限淘汰最早的', () => {
    for (let i = 0; i < 70; i++) rememberOriginal(`t${i}`, 'image/jpeg', 'eA==');
    expect(originalOf('t0')).toBeNull();
    expect(originalOf('t69')).not.toBeNull();
  });
});

describe('生图供应商列表（复用第三方供应商）', () => {
  it('只列已启用、有 Key、且识别出可用图片模型的供应商', () => {
    expect(choiceProviders(state).map((p) => p.id)).toEqual(['p1']);
    expect(choiceProviders({ ...state, bindings: [] })).toEqual([]);
    expect(choiceProviders(null)).toEqual([]);
  });
});
