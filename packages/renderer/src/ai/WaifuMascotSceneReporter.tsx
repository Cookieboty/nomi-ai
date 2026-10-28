import { MASCOT_EXPRESSIONS } from '@nomi-ai/avatar-runtime';
import { useEffect } from 'react';
import type { FC } from 'react';

import { waifuSceneStore } from './waifuSceneStore';

import { useMascot } from '@/contexts/MascotContext';

/** 把当前看板娘场景（模型 / 可选模型 / 表情）汇报给 waifuSceneStore，供 AI 工具读取。 */
const WaifuMascotSceneReporter: FC = () => {
  const { state, currentModel } = useMascot();

  useEffect(() => {
    if (!currentModel) {
      waifuSceneStore.reset();
      return;
    }
    waifuSceneStore.set({
      currentModel: currentModel.name,
      // VRM 没有「换装」概念：用可切换的模型列表代替
      currentCostume: null,
      availableCostumes: state.modelList.map((m) => m.name),
      availableMotions: [...MASCOT_EXPRESSIONS],
    });
  }, [currentModel, state.modelList]);

  useEffect(() => () => waifuSceneStore.reset(), []);

  return null;
};

export default WaifuMascotSceneReporter;
