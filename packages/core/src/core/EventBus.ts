/**
 * 事件总线 - 用于模块间解耦通信
 * 实现发布-订阅模式
 */

export interface IEventBus {
  emit(event: string, data?: any): void;
  on(event: string, handler: Function): void;
  off(event: string, handler: Function): void;
  once(event: string, handler: Function): void;
  clear(): void;
}

export class EventBus implements IEventBus {
  private listeners = new Map<string, Set<Function>>();

  /**
   * 发布事件
   */
  emit(event: string, data?: any): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(data);
        } catch (error) {
          console.error(`EventBus: Error in handler for event '${event}':`, error);
        }
      });
    }
  }

  /**
   * 订阅事件
   */
  on(event: string, handler: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  /**
   * 取消订阅
   */
  off(event: string, handler: Function): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /**
   * 订阅一次性事件
   */
  once(event: string, handler: Function): void {
    const onceWrapper = (data?: any) => {
      handler(data);
      this.off(event, onceWrapper);
    };
    this.on(event, onceWrapper);
  }

  /**
   * 清理所有事件监听器
   */
  clear(): void {
    this.listeners.clear();
  }

  /**
   * 获取事件监听器数量
   */
  getListenerCount(event: string): number {
    const handlers = this.listeners.get(event);
    return handlers ? handlers.size : 0;
  }

  /**
   * 获取所有事件名称
   */
  getEventNames(): string[] {
    return Array.from(this.listeners.keys());
  }
}

// 全局事件总线实例
export const eventBus = new EventBus();
