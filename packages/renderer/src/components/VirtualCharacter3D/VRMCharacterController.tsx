/* eslint-disable react/no-unknown-property -- react-three-fiber 的 JSX 元素属性 */
import { createLogger, perfMark, t } from '@nomi-ai/ui';
import { type VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { useFrame, useThree } from '@react-three/fiber';
import React, { useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { DEFAULT_VRM_MODEL_PATH } from '../../config/vrm';
import { createVrmBackend, type VrmBackend } from '../../mascot/backends/vrm';
import { mascotRegistry } from '../../mascot/MascotBackend';
import { loadMotionLibrary } from '../../mascot/motion/library';
import { MotionController } from '../../mascot/motion/MotionController';
import { useCharacter3DStore } from '../../stores/character3DStore';
import { type VRMCharacterControllerProps } from '../../types/character3d';

import VRMModelFallback from './VRMModelFallback';

const log = createLogger('vrm-controller');

/**
 * VRM 角色控制器：加载模型，并把它包装成 MascotBackend（口型/表情/眨眼/视线/待机）挂到 mascotRegistry。
 */
/** 性能指标写入 store 的间隔（秒） */
const PERF_REPORT_INTERVAL_S = 1;

export const VRMCharacterController: React.FC<VRMCharacterControllerProps> = ({
  modelPath,
  modelConfig,

  scale = 1,
  position = [0, 0, 0],
  onModelLoaded,
  onAnimationUpdate,
  onError,
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const vrmRef = useRef<VRM | null>(null);
  const backendRef = useRef<VrmBackend | null>(null);
  // EMA-smoothed dt + spring-bone accumulator → stable pacing under vsync jitter
  const smoothDt = useRef(1 / 60);
  const springAcc = useRef(0);
  const [useFallback, setUseFallback] = useState(false);

  const { scene } = useThree();
  // 用选择器分别订阅：整仓订阅会让性能指标的每次写入都重渲染本组件
  const currentExpression = useCharacter3DStore((s) => s.currentExpression);
  const setIsLoaded = useCharacter3DStore((s) => s.setIsLoaded);
  const updatePerformanceMetrics = useCharacter3DStore((s) => s.updatePerformanceMetrics);
  // 帧率统计累加在 ref 里，每秒才写入一次 store（逐帧 set 会触发 60Hz 的 store 更新）
  const perfAcc = useRef({ frames: 0, elapsed: 0 });

  useEffect(() => {
    let cancelled = false;
    let detach: (() => void) | null = null;
    const url = modelPath || DEFAULT_VRM_MODEL_PATH;
    // VRM 加载流程是外部数据同步：挂载 / 切换 modelPath 时初次拉取并派生 loading / fallback 状态
    /* eslint-disable react-hooks/set-state-in-effect */
    if (!url) {
      // no bundled VRM: only user/store models reach the 3D path
      setUseFallback(true);
      return;
    }
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    setUseFallback(false);
    setIsLoaded(false);
    /* eslint-enable react-hooks/set-state-in-effect */
    loader
      .loadAsync(url)
      .then((gltf) => {
        const vrm = gltf.userData.vrm as VRM | undefined;
        if (cancelled) {
          if (vrm) VRMUtils.deepDispose(vrm.scene);
          return;
        }
        if (!vrm) throw new Error(t('文件不包含 VRM 扩展'));

        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);
        // VRM 0.x 模型面向 -Z，统一转成 VRM 1.0 的朝向
        VRMUtils.rotateVRM0(vrm);
        vrm.scene.traverse((o) => {
          o.frustumCulled = false;
        });
        vrm.scene.scale.setScalar(scale);
        vrm.scene.position.set(...position);

        groupRef.current?.add(vrm.scene);
        vrmRef.current = vrm;
        const backend = createVrmBackend(vrm, scene, { expressionMap: modelConfig?.expressionMap });
        backendRef.current = backend;
        detach = mascotRegistry.attach(backend);
        // 动作库（CC0 Quaternius 重定向 + 原创手势）异步加载，失败时保留程序化站姿
        loadMotionLibrary()
          .then((lib) => {
            if (cancelled || backendRef.current !== backend) return;
            backend.attachMotions(new MotionController(vrm, lib, { allow: modelConfig?.motions }));
            mascotRegistry.refresh();
            perfMark('mascot-motions-loaded');
          })
          .catch((err) => log.warn('动作库加载失败', err));
        setIsLoaded(true);
        onModelLoaded?.(vrm);
        perfMark('mascot-model-loaded');
        perfMark('vrm-model-loaded');
      })
      .catch((err) => {
        if (cancelled) return;
        log.warn('VRM 加载失败，使用占位角色', err);
        setUseFallback(true);
        setIsLoaded(true);
        onError?.(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      detach?.();
      backendRef.current?.dispose();
      backendRef.current = null;
      const vrm = vrmRef.current;
      if (vrm) {
        // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup 期间访问 group 是 three.js 的回收需求
        groupRef.current?.remove(vrm.scene);
        VRMUtils.deepDispose(vrm.scene);
        vrmRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在模型路径变化时重新加载
  }, [modelPath]);

  // store 里的表情（旧 3D 控制 API）也走 backend
  useEffect(() => {
    if (currentExpression) backendRef.current?.setExpression(currentExpression);
  }, [currentExpression]);

  useFrame((state, delta) => {
    const vrm = vrmRef.current;
    if (!vrm) return;
    const raw = Math.min(Math.max(delta, 0), 1 / 20);
    // Blend toward measured frame time (vsync ~60/120Hz); kills 1-frame spikes
    smoothDt.current += (raw - smoothDt.current) * 0.28;
    const dt = smoothDt.current;
    backendRef.current?.update(dt, state.clock.getElapsedTime());
    // Spring bones: fixed 1/90s substeps with carry-over (smoother than ceil(dt/60))
    const STEP = 1 / 90;
    springAcc.current = Math.min(springAcc.current + dt, STEP * 8);
    let steps = 0;
    while (springAcc.current >= STEP - 1e-9 && steps < 8) {
      vrm.update(STEP);
      springAcc.current -= STEP;
      steps += 1;
    }
    // If we somehow stalled, still advance once so the pose doesn't freeze
    if (steps === 0) vrm.update(dt);
    onAnimationUpdate?.(vrm, dt);
    // 用未截断的真实帧间隔统计平均帧率（raw 被截到 1/20，会掩盖真正的卡顿）
    const acc = perfAcc.current;
    acc.frames += 1;
    acc.elapsed += Math.max(delta, 0);
    if (acc.elapsed >= PERF_REPORT_INTERVAL_S) {
      updatePerformanceMetrics({
        fps: acc.frames / acc.elapsed,
        memoryMB:
          ((performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? 0) /
          1024 /
          1024,
      });
      acc.frames = 0;
      acc.elapsed = 0;
    }
  });

  if (useFallback) {
    return <VRMModelFallback scale={scale} position={position} />;
  }
  return (
    <group
      ref={groupRef}
      scale={modelConfig?.scale ?? 1}
      position={modelConfig?.offset ?? [0, 0, 0]}
    />
  );
};

export default VRMCharacterController;
