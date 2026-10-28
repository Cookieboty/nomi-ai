/**
 * 服务容器 - 依赖注入容器
 * 管理所有核心服务的生命周期和依赖关系
 */

/**
 * 带类型的服务名：`get(HOST_PORTS)` 直接得到 `HostPorts`，不用每处手写泛型。
 * 运行时就是字符串，和老的字符串名共用一个命名空间。
 */
export type ServiceToken<T> = string & { readonly __serviceType?: (value: T) => T };

export function serviceToken<T>(name: string): ServiceToken<T> {
  return name as ServiceToken<T>;
}

export interface IServiceContainer {
  register<T>(name: ServiceToken<T>, factory: () => T): void;
  registerSingleton<T>(name: ServiceToken<T>, factory: () => T): void;
  get<T>(name: ServiceToken<T>): T;
  has(name: string): boolean;
  clear(): void;
}

export class ServiceContainer implements IServiceContainer {
  private services = new Map<string, any>();
  private singletons = new Map<string, any>();
  private factories = new Map<string, () => any>();

  /**
   * 注册瞬时服务
   */
  register<T>(name: ServiceToken<T>, factory: () => T): void {
    this.factories.set(name, factory);
  }

  /**
   * 注册单例服务
   */
  registerSingleton<T>(name: ServiceToken<T>, factory: () => T): void {
    this.factories.set(name, factory);
    this.singletons.set(name, null); // 标记为单例
  }

  /**
   * 获取服务实例
   */
  get<T>(name: ServiceToken<T>): T {
    // 检查是否为单例
    if (this.singletons.has(name)) {
      let instance = this.singletons.get(name);
      if (!instance) {
        const factory = this.factories.get(name);
        if (!factory) {
          throw new Error(`Service '${name}' not registered`);
        }
        instance = factory();
        this.singletons.set(name, instance);
      }
      return instance;
    }

    // 瞬时服务
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Service '${name}' not registered`);
    }
    return factory();
  }

  /**
   * 检查服务是否已注册
   */
  has(name: string): boolean {
    return this.factories.has(name);
  }

  /**
   * 清理所有服务
   */
  clear(): void {
    this.services.clear();
    this.singletons.clear();
    this.factories.clear();
  }
}

// 全局服务容器实例
export const serviceContainer = new ServiceContainer();
