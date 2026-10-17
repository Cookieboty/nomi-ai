import { t } from '@nomi-ai/ui';
import { createLogger } from '@nomi-ai/ui';
import React, { useState, useEffect } from 'react';

import { DEFAULT_VRM_MODEL_PATH } from '../../config/vrm';
import { useCharacter3DStore } from '../../stores/character3DStore';
import { type VirtualCharacter3DProps } from '../../types/character3d';

import { Character3DCanvas } from './Character3DCanvas';

const log = createLogger('VRM');

/**
 * 3D虚拟角色主组件
 * 集成所有3D功能的入口组件
 */
export const VirtualCharacter3D: React.FC<VirtualCharacter3DProps> = ({
  modelPath = DEFAULT_VRM_MODEL_PATH,
  modelConfig,
  enableVoiceSync = true,
  enableControls = false,
  transparent = true,
  className = '',
  style = {},
  onReady,
  onError,
  ...props
}) => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { isLoaded, isVisible, setCurrentModel } = useCharacter3DStore();

  // 初始化3D角色系统
  useEffect(() => {
    const initialize = async () => {
      try {
        log.info('VirtualCharacter3D: 开始初始化...');

        // 设置当前模型
        setCurrentModel(modelPath);

        setIsInitialized(true);
        log.info('VirtualCharacter3D: 初始化完成');

        // 触发就绪回调
        onReady?.();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : t('初始化失败');
        setError(errorMessage);
        onError?.(errorMessage);
        log.error('初始化失败:', err);
      }
    };

    initialize();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在模型路径变化时重初始化，回调更稳定
  }, [modelPath]); // 移除store函数和callback依赖

  // 处理模型加载成功
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 遗留代码，沿用既有类型
  const handleModelLoaded = (vrm: any) => {
    log.info('VirtualCharacter3D: 模型加载成功', vrm);

    // 触发模型加载事件
    window.dispatchEvent(
      new CustomEvent('character3d:modelLoaded', {
        detail: { vrm, modelPath },
      }),
    );
  };

  // 处理错误
  const handleError = (errorMessage: string) => {
    setError(errorMessage);
    onError?.(errorMessage);
    log.error('错误:', errorMessage);
  };

  // 如果出现错误，显示错误状态
  if (error) {
    return (
      <div
        className={`virtual-character-3d-error ${className}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          background: 'rgba(255, 0, 0, 0.1)',
          border: '1px solid rgba(255, 0, 0, 0.3)',
          borderRadius: '8px',
          color: '#cc0000',
          fontSize: '14px',
          textAlign: 'center',
          padding: '20px',
          ...style,
        }}
      >
        <div>
          <div style={{ marginBottom: '8px', fontWeight: 'bold' }}>{t('3D角色加载失败')}</div>
          <div style={{ fontSize: '12px', opacity: 0.8 }}>{error}</div>
        </div>
      </div>
    );
  }

  // 如果未初始化，显示加载状态
  if (!isInitialized) {
    return (
      <div
        className={`virtual-character-3d-loading ${className}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          background: 'rgba(0, 0, 0, 0.05)',
          borderRadius: '8px',
          ...style,
        }}
      >
        <div style={{ textAlign: 'center', color: '#666' }}>
          <div style={{ marginBottom: '8px' }}>{t('正在初始化3D系统...')}</div>
        </div>
      </div>
    );
  }

  // 如果不可见，返回空
  if (!isVisible) {
    return null;
  }

  return (
    <div
      className={`virtual-character-3d ${className}`}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        ...style,
      }}
      {...props}
    >
      <Character3DCanvas
        modelPath={modelPath}
        modelConfig={modelConfig}
        enableControls={enableControls}
        transparent={transparent}
        onModelLoaded={handleModelLoaded}
        onError={handleError}
        style={{ width: '100%', height: '100%' }}
      />

      {/* 状态指示器 */}
      {(process.env.NODE_ENV === 'development' || enableControls) && (
        <div
          style={{
            position: 'absolute',
            top: '10px',
            right: '10px',
            background: 'rgba(0, 0, 0, 0.7)',
            color: 'white',
            padding: '8px 12px',
            borderRadius: '4px',
            fontSize: '12px',
            zIndex: 1000,
          }}
        >
          <div>
            {t('模型:')} {isLoaded ? t('已加载') : t('加载中')}
          </div>
        </div>
      )}
    </div>
  );
};

// 默认导出
export default VirtualCharacter3D;

// 同时导出相关类型和组件
export { Character3DCanvas } from './Character3DCanvas';
export { VRMCharacterController } from './VRMCharacterController';
export * from '../../types/character3d';
export { useCharacter3DStore } from '../../stores/character3DStore';
