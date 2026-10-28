/* eslint-disable @typescript-eslint/no-explicit-any -- 遗留的宽松类型，沿用既有定义 */
/**
 * @file Define the type of the global window object.
 * @module types/window
 */
interface Window {
  /**
   * Asteroids game class.
   * @type {any}
   */
  Asteroids: any;
  /**
   * Asteroids game player array.
   * @type {any[]}
   */
  ASTEROIDSPLAYERS: any[];
  /**
   * 是否启用拖动功能
   * @type {boolean}
   */
  drag?: boolean;
  /**
   * 拖动清理函数
   * @type {() => void}
   */
  cleanupDrag?: () => void;
  /**
   * 是否已经完成初始化
   * @type {boolean}
   */
  isInitialized?: boolean;
}
