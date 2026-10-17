/* eslint-disable react/no-unknown-property -- react-three-fiber 的 JSX 元素属性 */
import { t } from '@nomi-ai/ui';
import { createLogger } from '@nomi-ai/ui';
import { OrbitControls, useProgress, Html } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import React, { Suspense, useRef, useEffect, useState } from 'react';
import type * as THREE from 'three';

import MascotInteractionLayer from '../../mascot/interaction/MascotInteractionLayer';
import { useCharacter3DStore } from '../../stores/character3DStore';
import { type Character3DCanvasProps } from '../../types/character3d';

import { VRMCharacterController } from './VRMCharacterController';

const log = createLogger('VRM');

/**
 * 3D角色渲染画布组件
 * 基于React Three Fiber实现的高性能3D渲染
 */
/** 按模型配置调整取景（默认：全身，相机高 0.82m、距离 3.2m、fov 35°） */
const CameraRig: React.FC<{ camera?: { height?: number; distance?: number; fov?: number } }> = ({
  camera,
}) => {
  const { camera: cam } = useThree();
  useEffect(() => {
    const height = camera?.height ?? 0.82;
    // three.js 的 camera 对象来自 useThree，是可变 three 实例，这里按 three 的约定直接修改属性
    /* eslint-disable react-hooks/immutability */
    cam.position.set(0, height, camera?.distance ?? 3.2);
    if ('fov' in cam) {
      (cam as THREE.PerspectiveCamera).fov = camera?.fov ?? 35;
      (cam as THREE.PerspectiveCamera).updateProjectionMatrix();
    }
    cam.lookAt(0, height - 0.02, 0);
    /* eslint-enable react-hooks/immutability */
  }, [cam, camera?.height, camera?.distance, camera?.fov]);
  return null;
};

export const Character3DCanvas: React.FC<Character3DCanvasProps> = ({
  modelPath,
  modelConfig,
  enableControls = false,
  transparent = true,
  className = '',
  onModelLoaded,
  onError,
  style,
  ...htmlProps
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 窗口隐藏 / 最小化时暂停渲染
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  const { isLoaded, renderQuality, isVisible, setRenderQuality } = useCharacter3DStore();

  // 根据性能自动调整渲染质量
  useEffect(() => {
    const detectPerformance = () => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');

      if (!gl) {
        setRenderQuality('low');
        return;
      }

      const renderer = gl.getParameter(gl.RENDERER);
      const vendor = gl.getParameter(gl.VENDOR);

      // 简单的性能检测逻辑
      if (renderer.includes('Intel') && !renderer.includes('Iris')) {
        setRenderQuality('medium');
      } else if (renderer.includes('NVIDIA') || renderer.includes('AMD')) {
        setRenderQuality('high');
      } else {
        setRenderQuality('medium');
      }
    };

    detectPerformance();
  }, [setRenderQuality]);

  // 获取渲染配置
  const getRenderConfig = () => {
    switch (renderQuality) {
      case 'low':
        return {
          antialias: false,
          pixelRatio: Math.min(window.devicePixelRatio, 1),
          shadowMapSize: 512,
          toneMapping: false,
        };
      case 'medium':
        return {
          antialias: true,
          pixelRatio: Math.min(window.devicePixelRatio, 1.5),
          shadowMapSize: 1024,
          toneMapping: true,
        };
      case 'high':
        return {
          antialias: true,
          pixelRatio: window.devicePixelRatio,
          shadowMapSize: 2048,
          toneMapping: true,
        };
      case 'ultra':
        return {
          antialias: true,
          pixelRatio: window.devicePixelRatio,
          shadowMapSize: 4096,
          toneMapping: true,
        };
      default:
        return {
          antialias: true,
          pixelRatio: Math.min(window.devicePixelRatio, 1.5),
          shadowMapSize: 1024,
          toneMapping: true,
        };
    }
  };

  const renderConfig = getRenderConfig();

  // 加载指示器组件
  // 嵌套在父组件内是为了共享 Canvas context，不方便上移到模块级
  const LoadingIndicator = () => {
    const { progress } = useProgress();

    return (
      <Html center>
        <div className="loading-indicator">
          <div className="loading-spinner"></div>
          <div className="loading-text">
            {t('加载3D模型中...')} {Math.round(progress)}%
          </div>
        </div>
      </Html>
    );
  };

  // 性能监控组件
  // 嵌套在父组件内是为了共享渲染质量状态，useFrame 内修改 ref 是 r3f 的推荐用法
  const PerformanceMonitor = () => {
    const { gl: _gl } = useThree();
    const frameCount = useRef(0);
    // eslint-disable-next-line react-hooks/purity -- performance.now() 作为初值仅在首次挂载时读取
    const lastTime = useRef(performance.now());

    useFrame(() => {
      frameCount.current++;

      if (frameCount.current % 60 === 0) {
        const now = performance.now();
        const fps = 60000 / (now - lastTime.current);
        lastTime.current = now;

        // 如果帧率过低，自动降低质量
        if (fps < 25 && renderQuality !== 'low') {
          log.info('检测到低帧率，自动降低渲染质量');
          setRenderQuality(
            renderQuality === 'ultra' ? 'high' : renderQuality === 'high' ? 'medium' : 'low',
          );
        }
      }
    });

    return null;
  };

  if (!isVisible) {
    return null;
  }

  return (
    <div className={`character-3d-canvas ${className}`} style={style} {...htmlProps}>
      <Canvas
        ref={canvasRef}
        gl={{
          antialias: renderConfig.antialias,
          alpha: transparent,
          // 逐像素点击穿透需要读回上一帧的 alpha
          preserveDrawingBuffer: true,
          powerPreference: 'high-performance',
          // Let the compositor vsync; avoid tearing on transparent desktop windows
          stencil: false,
        }}
        dpr={renderConfig.pixelRatio}
        // rAF is display-synced; pause when the document is hidden
        frameloop={hidden ? 'never' : 'always'}
        // Adaptive DPR when GPU falls behind (R3F performance.max defaults to 1)
        performance={{ min: 0.5, max: 1, debounce: 200 }}
        camera={{
          // 全身取景：VRoid 模型约 1.5m 高，原点在脚底
          position: [0, 0.82, 3.2],
          fov: 35,
          near: 0.1,
          far: 1000,
        }}
        onCreated={({ camera, gl }) => {
          camera.lookAt(0, 0.8, 0);
          // Cap pixel ratio again after context creation (HiDPI + transparent window)
          gl.setPixelRatio(renderConfig.pixelRatio);
        }}
        shadows={renderQuality !== 'low'}
        style={{
          background: transparent ? 'transparent' : '#f0f0f0',
          width: '100%',
          height: '100%',
        }}
      >
        {/* 环境光 */}
        <ambientLight args={[0xffffff, 0.6]} />

        {/* 主光源 */}
        <directionalLight
          position={[10, 10, 5]}
          args={[0xffffff, 1]}
          castShadow={renderQuality !== 'low'}
        />

        {/* 补充光源 */}
        <pointLight position={[-10, 0, -20]} args={[0xffffff, 0.5]} />
        <pointLight position={[0, -10, 0]} args={[0xffffff, 0.3]} />

        <CameraRig camera={modelConfig?.camera} />

        {/* 桌面互动：点击穿透 / 拖拽 / 触摸反应 / 视线 */}
        {transparent && <MascotInteractionLayer />}

        {/* 性能监控 */}
        {/* eslint-disable-next-line react-hooks/static-components -- 性能监控需共享父组件的 renderQuality 状态 */}
        <PerformanceMonitor />

        {/* VRM角色控制器 */}
        {modelPath && (
          /* eslint-disable-next-line react-hooks/static-components -- Suspense fallback 共享父组件的 t() 翻译 */
          <Suspense fallback={<LoadingIndicator />}>
            <VRMCharacterController
              modelPath={modelPath}
              modelConfig={modelConfig}
              enablePhysics={renderQuality !== 'low'}
              enableExpressions={true}
              enableLookAt={true}
              onModelLoaded={onModelLoaded}
              onError={onError}
            />
          </Suspense>
        )}

        {/* 开发模式下的控制器 */}
        {enableControls && (
          <OrbitControls
            enablePan={true}
            enableZoom={true}
            enableRotate={true}
            minDistance={1}
            maxDistance={10}
            target={[0, 1, 0]}
          />
        )}
      </Canvas>

      {/* 内联样式 */}
      <style>{`
        .character-3d-canvas {
          width: 100%;
          height: 100%;
          position: relative;
        }

        .loading-indicator {
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 20px;
          background: rgba(0, 0, 0, 0.8);
          border-radius: 10px;
          color: white;
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }

        .loading-spinner {
          width: 40px;
          height: 40px;
          border: 3px solid rgba(255, 255, 255, 0.3);
          border-top: 3px solid #fff;
          border-radius: 50%;
          animation: spin 1s linear infinite;
          margin-bottom: 10px;
        }

        .loading-text {
          font-size: 14px;
          text-align: center;
        }

        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};
