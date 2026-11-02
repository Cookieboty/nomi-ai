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

  it('多出来的是数字 / 中文数字 / 字母的不并：不同项目、不同数值（#223）', () => {
    expect(isDuplicateFact('用户项目A预算是10万元', '用户项目AB预算是100万元')).toBe(false);
    expect(isDuplicateFact('用户的项目代号是Atls计划', '用户的项目代号是Atlas计划')).toBe(false);
    expect(isDuplicateFact('用户每周跑步三次左右', '用户每周跑步三十次左右')).toBe(false);
    expect(isDuplicateFact('用户喜欢早上喝咖啡', '用户not喜欢早上喝咖啡')).toBe(false);
    const f = (id: string, text: string, source: string, updatedAt: number) => ({
      id,
      text,
      source,
      updatedAt,
    });
    // 加载时的合并：两条用户亲口说的不同事实都留下
    const r = dedupeFacts([
      f('a', '用户项目A预算是10万元', 'user', 1),
      f('b', '用户项目AB预算是100万元', 'user', 2),
    ]);
    expect(r.kept.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r.dropped).toEqual([]);
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
