import { restoreChatBounds } from '../../../src/core/chatWindowBounds';

const main = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 2560, height: 1400 };
const MIN = { width: 760, height: 560 };

describe('restoreChatBounds（对话窗口记住上次的位置与大小）', () => {
  it('没有保存过 / 数据不对：返回 null，用默认的居中尺寸', () => {
    expect(restoreChatBounds(undefined, [main], MIN)).toBeNull();
    expect(restoreChatBounds({ x: 1, y: 2, width: 'big' }, [main], MIN)).toBeNull();
    expect(restoreChatBounds({ x: 1, y: 2, width: 900, height: 700 }, [], MIN)).toBeNull();
  });

  it('还在屏幕上：原样恢复（含副屏）与最大化标记', () => {
    expect(restoreChatBounds({ x: 100, y: 80, width: 1300, height: 900 }, [main], MIN)).toEqual({
      x: 100,
      y: 80,
      width: 1300,
      height: 900,
    });
    expect(
      restoreChatBounds(
        { x: 2100, y: 50, width: 1600, height: 1000, maximized: true },
        [main, right],
        MIN,
      ),
    ).toEqual({ x: 2100, y: 50, width: 1600, height: 1000, maximized: true });
  });

  it('副屏拔掉了：保留大小、居中到主屏', () => {
    expect(restoreChatBounds({ x: 2100, y: 50, width: 1200, height: 800 }, [main], MIN)).toEqual({
      x: 360,
      y: 120,
      width: 1200,
      height: 800,
    });
  });

  it('比屏幕大 / 比最小尺寸小：夹到范围内；超出右下角时推回工作区', () => {
    expect(restoreChatBounds({ x: 0, y: 0, width: 4000, height: 3000 }, [main], MIN)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1040,
    });
    expect(restoreChatBounds({ x: 10, y: 10, width: 300, height: 200 }, [main], MIN)).toMatchObject(
      { width: 760, height: 560 },
    );
    expect(restoreChatBounds({ x: 1700, y: 900, width: 900, height: 700 }, [main], MIN)).toEqual({
      x: 1020,
      y: 340,
      width: 900,
      height: 700,
    });
  });
});
