/**
 * CacheService单元测试
 */

import { CacheService } from '../../../src/services/CacheService';
import { testUtils } from '../../setup';

describe('CacheService', () => {
  let cacheService: CacheService;
  let mockLogger: any;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLogger = testUtils.createMockLogger();
    cacheService = new CacheService(
      {
        maxSize: 5,
        defaultTtl: 1000,
        cleanupInterval: 100,
      },
      mockLogger,
    );
  });

  afterEach(() => {
    cacheService.destroy();
    jest.useRealTimers();
  });

  describe('基本缓存操作', () => {
    test('应该设置和获取缓存项', () => {
      cacheService.set('key1', 'value1');
      expect(cacheService.get('key1')).toBe('value1');
    });

    test('应该返回null对于不存在的键', () => {
      expect(cacheService.get('nonexistent')).toBeNull();
    });

    test('应该检查键是否存在', () => {
      cacheService.set('key1', 'value1');
      expect(cacheService.has('key1')).toBe(true);
      expect(cacheService.has('nonexistent')).toBe(false);
    });

    test('应该删除缓存项', () => {
      cacheService.set('key1', 'value1');
      expect(cacheService.delete('key1')).toBe(true);
      expect(cacheService.get('key1')).toBeNull();
      expect(cacheService.delete('nonexistent')).toBe(false);
    });

    test('应该清空所有缓存', () => {
      cacheService.set('key1', 'value1');
      cacheService.set('key2', 'value2');

      cacheService.clear();

      expect(cacheService.size()).toBe(0);
      expect(cacheService.get('key1')).toBeNull();
      expect(cacheService.get('key2')).toBeNull();
    });
  });

  describe('TTL过期机制', () => {
    test('应该在TTL过期后返回null', () => {
      cacheService.set('key1', 'value1', 500);

      expect(cacheService.get('key1')).toBe('value1');

      // 快进时间
      jest.advanceTimersByTime(600);

      expect(cacheService.get('key1')).toBeNull();
      expect(cacheService.has('key1')).toBe(false);
    });

    test('应该使用默认TTL', () => {
      cacheService.set('key1', 'value1'); // 使用默认TTL: 1000ms

      expect(cacheService.get('key1')).toBe('value1');

      jest.advanceTimersByTime(500);
      expect(cacheService.get('key1')).toBe('value1');

      jest.advanceTimersByTime(600);
      expect(cacheService.get('key1')).toBeNull();
    });

    test('应该在过期时自动清理项目', () => {
      cacheService.set('key1', 'value1', 500);
      cacheService.set('key2', 'value2', 1500);

      expect(cacheService.size()).toBe(2);

      // 运行清理
      jest.advanceTimersByTime(600);
      cacheService.cleanup();

      expect(cacheService.size()).toBe(1);
      expect(cacheService.get('key2')).toBe('value2');
    });
  });

  describe('LRU淘汰机制', () => {
    test('应该在超过最大大小时淘汰最旧的项', () => {
      // 添加5个项目（达到最大值）
      for (let i = 1; i <= 5; i++) {
        cacheService.set(`key${i}`, `value${i}`);
      }

      expect(cacheService.size()).toBe(5);

      // 添加第6个项目，应该淘汰最旧的
      cacheService.set('key6', 'value6');

      expect(cacheService.size()).toBe(5);
      expect(cacheService.get('key1')).toBeNull(); // 最旧的应该被淘汰
      expect(cacheService.get('key6')).toBe('value6'); // 新的应该存在
    });

    test('访问项目应该更新其位置', () => {
      // 添加3个项目
      cacheService.set('key1', 'value1');
      cacheService.set('key2', 'value2');
      cacheService.set('key3', 'value3');

      // 访问key1使其变为最新访问
      cacheService.get('key1');

      // 添加更多项目直到达到限制
      cacheService.set('key4', 'value4');
      cacheService.set('key5', 'value5');
      cacheService.set('key6', 'value6'); // 这应该淘汰key2（最旧的未访问）

      expect(cacheService.get('key1')).toBe('value1'); // 应该还在
      expect(cacheService.get('key2')).toBeNull(); // 应该被淘汰
    });
  });

  describe('缓存统计', () => {
    test('应该跟踪命中和未命中', () => {
      cacheService.set('key1', 'value1');

      cacheService.get('key1'); // 命中
      cacheService.get('key2'); // 未命中
      cacheService.get('key1'); // 命中
      cacheService.get('key3'); // 未命中

      const stats = cacheService.getStats();
      expect(stats.hitCount).toBe(2);
      expect(stats.missCount).toBe(2);
      expect(stats.hitRate).toBe(0.5);
    });

    test('应该提供准确的统计信息', () => {
      cacheService.set('key1', 'value1');
      cacheService.set('key2', 'value2');

      const stats = cacheService.getStats();
      expect(stats.size).toBe(2);
      expect(stats.maxSize).toBe(5);
      expect(stats.oldestItem).toBeGreaterThan(0);
      expect(stats.newestItem).toBeGreaterThan(0);
    });
  });

  describe('高级功能', () => {
    test('应该获取热点数据', () => {
      cacheService.set('key1', 'value1');
      cacheService.set('key2', 'value2');
      cacheService.set('key3', 'value3');

      // 不同的访问次数
      cacheService.get('key1');
      cacheService.get('key1');
      cacheService.get('key1');
      cacheService.get('key2');
      cacheService.get('key2');
      cacheService.get('key3');

      const hotItems = cacheService.getHotItems(2);
      expect(hotItems).toHaveLength(2);
      expect(hotItems[0].key).toBe('key1');
      expect(hotItems[0].accessCount).toBe(3);
      expect(hotItems[1].key).toBe('key2');
      expect(hotItems[1].accessCount).toBe(2);
    });

    test('应该支持缓存预热', () => {
      const items = [
        { key: 'key1', value: 'value1' },
        { key: 'key2', value: 'value2', ttl: 2000 },
        { key: 'key3', value: 'value3' },
      ];

      cacheService.warmup(items);

      expect(cacheService.size()).toBe(3);
      expect(cacheService.get('key1')).toBe('value1');
      expect(cacheService.get('key2')).toBe('value2');
      expect(cacheService.get('key3')).toBe('value3');
    });

    test('应该动态调整最大大小', () => {
      // 添加5个项目
      for (let i = 1; i <= 5; i++) {
        cacheService.set(`key${i}`, `value${i}`);
      }

      expect(cacheService.size()).toBe(5);

      // 减少最大大小
      cacheService.setMaxSize(3);

      expect(cacheService.size()).toBe(3);
    });
  });

  describe('定期清理', () => {
    test('应该定期自动清理过期项', () => {
      cacheService.set('key1', 'value1', 50); // 50ms TTL
      cacheService.set('key2', 'value2', 200); // 200ms TTL

      expect(cacheService.size()).toBe(2);

      // 快进到第一次清理
      jest.advanceTimersByTime(100);

      expect(cacheService.size()).toBe(1); // key1应该被清理
      expect(cacheService.get('key2')).toBe('value2');
    });

    test('应该在销毁时停止清理定时器', () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      cacheService.destroy();

      expect(clearIntervalSpy).toHaveBeenCalled();
    });
  });

  describe('错误处理', () => {
    test('应该处理无效的TTL值', () => {
      cacheService.set('key1', 'value1', -100); // 负数TTL
      expect(cacheService.get('key1')).toBe('value1'); // 应该使用默认TTL
    });

    test('应该处理空键', () => {
      expect(() => {
        cacheService.set('', 'value');
      }).not.toThrow();

      expect(cacheService.get('')).toBe('value');
    });
  });

  describe('性能', () => {
    test('大量操作应该保持高性能', () => {
      const operations = 1000;
      const startTime = Date.now();

      for (let i = 0; i < operations; i++) {
        cacheService.set(`key${i}`, `value${i}`);
        if (i % 2 === 0) {
          cacheService.get(`key${i}`);
        }
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(100); // 应该在100ms内完成
    });
  });
});
