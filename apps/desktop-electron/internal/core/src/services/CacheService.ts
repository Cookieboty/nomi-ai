/**
 * 缓存服务 - 提供高效的内存缓存管理
 * 支持LRU算法、TTL过期和自动清理
 */

import { type ILoggerService } from './LoggerService';

export interface CacheItem<T> {
  value: T;
  timestamp: number;
  ttl?: number;
  accessCount: number;
  lastAccessed: number;
}

export interface CacheOptions {
  maxSize?: number;
  defaultTtl?: number;
  cleanupInterval?: number;
}

export interface ICacheService {
  set<T>(key: string, value: T, ttl?: number): void;
  get<T>(key: string): T | null;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  size(): number;
  cleanup(): number;
  getStats(): CacheStats;
}

export interface CacheStats {
  size: number;
  maxSize: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  oldestItem: number;
  newestItem: number;
}

export class CacheService implements ICacheService {
  private cache = new Map<string, CacheItem<any>>();
  private accessOrder = new Map<string, number>(); // LRU tracking
  private maxSize: number;
  private defaultTtl: number;
  private cleanupInterval: number;
  private cleanupTimer?: NodeJS.Timeout;
  private hitCount = 0;
  private missCount = 0;
  private accessCounter = 0;
  private logger?: ILoggerService;

  constructor(options: CacheOptions = {}, logger?: ILoggerService) {
    this.maxSize = options.maxSize || 1000;
    this.defaultTtl = options.defaultTtl || 5 * 60 * 1000; // 5分钟
    this.cleanupInterval = options.cleanupInterval || 60 * 1000; // 1分钟
    this.logger = logger;

    // 启动定期清理
    this.startCleanupTimer();
  }

  /**
   * 设置缓存项
   */
  set<T>(key: string, value: T, ttl?: number): void {
    const now = Date.now();
    const item: CacheItem<T> = {
      value,
      timestamp: now,
      ttl: typeof ttl === 'number' && ttl > 0 ? ttl : this.defaultTtl,
      accessCount: 0,
      lastAccessed: now,
    };

    // 如果缓存已满，删除最旧的项
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    this.cache.set(key, item);
    this.accessOrder.set(key, ++this.accessCounter);

    this.logger?.debug(`缓存设置`, { key, size: this.cache.size });
  }

  /**
   * 获取缓存项
   */
  get<T>(key: string): T | null {
    const item = this.cache.get(key);

    if (!item) {
      this.missCount++;
      this.logger?.debug(`缓存未命中`, { key });
      return null;
    }

    // 检查是否过期
    if (this.isExpired(item)) {
      this.cache.delete(key);
      this.accessOrder.delete(key);
      this.missCount++;
      this.logger?.debug(`缓存已过期`, { key });
      return null;
    }

    // 更新访问信息
    item.accessCount++;
    item.lastAccessed = Date.now();
    this.accessOrder.set(key, ++this.accessCounter);
    this.hitCount++;

    this.logger?.debug(`缓存命中`, { key, accessCount: item.accessCount });
    return item.value;
  }

  /**
   * 检查缓存是否存在
   */
  has(key: string): boolean {
    const item = this.cache.get(key);
    if (!item) return false;

    if (this.isExpired(item)) {
      this.cache.delete(key);
      this.accessOrder.delete(key);
      return false;
    }

    return true;
  }

  /**
   * 删除缓存项
   */
  delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    this.accessOrder.delete(key);

    if (deleted) {
      this.logger?.debug(`缓存删除`, { key });
    }

    return deleted;
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.accessOrder.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.accessCounter = 0;

    this.logger?.info(`缓存已清空`, { previousSize: size });
  }

  /**
   * 获取缓存大小
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * 清理过期项
   */
  cleanup(): number {
    let cleanedCount = 0;

    for (const [key, item] of this.cache.entries()) {
      if (this.isExpired(item)) {
        this.cache.delete(key);
        this.accessOrder.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger?.debug(`清理过期缓存`, { count: cleanedCount });
    }

    return cleanedCount;
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): CacheStats {
    const total = this.hitCount + this.missCount;
    const hitRate = total > 0 ? this.hitCount / total : 0;

    let oldestItem = Date.now();
    let newestItem = 0;

    for (const item of this.cache.values()) {
      oldestItem = Math.min(oldestItem, item.timestamp);
      newestItem = Math.max(newestItem, item.timestamp);
    }

    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitCount: this.hitCount,
      missCount: this.missCount,
      hitRate,
      oldestItem: this.cache.size > 0 ? oldestItem : 0,
      newestItem: this.cache.size > 0 ? newestItem : 0,
    };
  }

  /**
   * 检查项是否过期
   */
  private isExpired(item: CacheItem<any>): boolean {
    if (!item.ttl) return false;
    return Date.now() - item.timestamp > item.ttl;
  }

  /**
   * LRU淘汰策略
   */
  private evictLRU(): void {
    let lruKey = '';
    let lruAccess = Infinity;

    for (const [key, accessTime] of this.accessOrder.entries()) {
      if (accessTime < lruAccess) {
        lruAccess = accessTime;
        lruKey = key;
      }
    }

    if (lruKey) {
      this.cache.delete(lruKey);
      this.accessOrder.delete(lruKey);
      this.logger?.debug(`LRU淘汰缓存项`, { key: lruKey });
    }
  }

  /**
   * 启动定期清理定时器
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.cleanupInterval);
  }

  /**
   * 停止清理定时器
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * 设置最大缓存大小
   */
  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize;

    // 如果当前大小超过新的最大值，进行清理
    while (this.cache.size > this.maxSize) {
      this.evictLRU();
    }
  }

  /**
   * 获取热点数据（访问次数最多的前N项）
   */
  getHotItems(
    count: number = 10,
  ): Array<{ key: string; accessCount: number; lastAccessed: number }> {
    const items: Array<{ key: string; accessCount: number; lastAccessed: number }> = [];

    for (const [key, item] of this.cache.entries()) {
      items.push({
        key,
        accessCount: item.accessCount,
        lastAccessed: item.lastAccessed,
      });
    }

    return items.sort((a, b) => b.accessCount - a.accessCount).slice(0, count);
  }

  /**
   * 预热缓存（批量设置）
   */
  warmup<T>(items: Array<{ key: string; value: T; ttl?: number }>): void {
    this.logger?.info(`开始缓存预热`, { count: items.length });

    for (const item of items) {
      this.set(item.key, item.value, item.ttl);
    }

    this.logger?.info(`缓存预热完成`, { totalSize: this.cache.size });
  }

  /**
   * 销毁缓存服务
   */
  destroy(): void {
    this.stopCleanupTimer();
    this.clear();
    this.logger?.info('缓存服务已销毁');
  }
}
