import { dedupeFacts, isDuplicateFact } from '../../../src/memory/episodes';

describe('事实去重：说法几乎一样的视为同一条', () => {
  it('称呼为 / 称为：同一件事', () => {
    expect(isDuplicateFact('用户被助手称呼为「言哥」', '用户被助手称为「言哥」')).toBe(true);
    expect(isDuplicateFact('用户被称呼为言哥', '用户被助手称呼为言哥')).toBe(true);
  });

  it('只差关键字的不并：喜欢猫 / 喜欢狗、北京 / 上海、日期不同', () => {
    expect(isDuplicateFact('用户喜欢养猫', '用户喜欢养狗')).toBe(false);
    expect(isDuplicateFact('用户住在北京', '用户住在上海')).toBe(false);
    expect(isDuplicateFact('用户的生日是5月1日', '用户的生日是6月1日')).toBe(false);
    // 多出来的是否定词：意思相反，不并
    expect(isDuplicateFact('用户不喜欢吃香菜', '用户喜欢吃香菜')).toBe(false);
    // 多出来的字太多：不并
    expect(isDuplicateFact('用户在做项目', '用户在北京的公司做一个项目')).toBe(false);
    // 太短的只认完全相同 / 包含
    expect(isDuplicateFact('喜欢猫', '喜欢狗')).toBe(false);
  });

  it('原有规则不变：完全相同、互相包含', () => {
    expect(isDuplicateFact('用户叫言哥', '用户叫言哥。')).toBe(true);
    expect(isDuplicateFact('用户在做 Nomi 项目', '用户在做 Nomi 项目，用 Go 重写')).toBe(true);
  });

  it('合并已存的重复：用户亲口说的优先，其次较新的', () => {
    const f = (id: string, text: string, source: string, updatedAt: number) => ({
      id,
      text,
      source,
      updatedAt,
    });
    const r = dedupeFacts([
      f('a', '用户被助手称呼为「言哥」', 'distilled', 1),
      f('b', '用户被助手称为「言哥」', 'distilled', 2),
      f('c', '用户喜欢养猫', 'distilled', 1),
      f('d', '用户被称呼为言哥', 'user', 0),
    ]);
    expect(r.kept.map((x) => x.id)).toEqual(['c', 'd']);
    expect(r.dropped.sort()).toEqual(['a', 'b']);
  });
});
