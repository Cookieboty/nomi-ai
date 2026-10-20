import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
} from 'react';
import type { ReactNode } from 'react';

import { lipSyncStore } from '@/ai/lipSyncStore';
import { clearSelectedModel, loadCatalog, pickModel, type MascotModel } from '@/mascot/catalog';
import { setActiveCharacter } from '@/mascot/characterVoice';

export interface MascotConfig {
  /** 工具栏按钮 id 列表 */
  tools: string[];
  /** 是否允许拖动窗口 */
  drag?: boolean;
}

export interface MascotState {
  currentMessage: string | null;
  messagePriority: number;
  /** 气泡里显示「查看全文」（AI 回复被截短时） */
  messageMore?: boolean;
  dragEnabled: boolean;
  modelList: MascotModel[];
  /** 当前模型 name（model-list.json 中的 name；只内置 Nomi 一个角色） */
  modelName: string | null;
  /** 浮层：动作菜单 / 致谢 / 互动设置 */
  panel: 'motions' | 'credits' | 'interaction' | null;
}

export type MascotAction =
  | {
      type: 'SET_MESSAGE';
      payload: { text: string; priority: number; timeout?: number; more?: boolean };
    }
  | { type: 'CLEAR_MESSAGE' }
  | { type: 'TOGGLE_DRAG'; payload: boolean }
  | { type: 'SET_MODEL_LIST'; payload: MascotModel[] }
  | { type: 'SET_PANEL'; payload: MascotState['panel'] };

const initialState: MascotState = {
  currentMessage: null,
  messagePriority: 0,
  dragEnabled: false,
  modelList: [],
  modelName: null,
  panel: null,
};

/** A new bubble line replaces the current one only at an equal or higher priority. */
export function acceptsMessage(
  current: { currentMessage: string | null; messagePriority: number },
  priority: number,
): boolean {
  return current.currentMessage === null || priority >= current.messagePriority;
}

export function mascotReducer(state: MascotState, action: MascotAction): MascotState {
  switch (action.type) {
    case 'SET_MESSAGE':
      if (acceptsMessage(state, action.payload.priority)) {
        return {
          ...state,
          currentMessage: action.payload.text,
          messagePriority: action.payload.priority,
          messageMore: action.payload.more === true,
        };
      }
      return state;
    case 'CLEAR_MESSAGE':
      return { ...state, currentMessage: null, messagePriority: 0, messageMore: false };
    case 'TOGGLE_DRAG':
      return { ...state, dragEnabled: action.payload };
    case 'SET_MODEL_LIST':
      return {
        ...state,
        modelList: action.payload,
        modelName: pickModel(action.payload, state.modelName)?.name ?? null,
      };
    case 'SET_PANEL':
      return { ...state, panel: action.payload };
    default:
      return state;
  }
}

interface MascotContextType {
  state: MascotState;
  dispatch: React.Dispatch<MascotAction>;
  config: MascotConfig;
  currentModel: MascotModel | undefined;
}

let lastSpokeAt = 0;
/** 鼠标停在气泡上（在读 / 要点「查看全文」）时不收起 */
export const bubbleHover = { on: false };
lipSyncStore.subscribe((rms) => {
  if (rms > 0.02) lastSpokeAt = Date.now();
});

const MascotContext = createContext<MascotContextType | undefined>(undefined);

export const MascotProvider: React.FC<{ children: ReactNode; config: MascotConfig }> = ({
  children,
  config,
}) => {
  const [state, rawDispatch] = useReducer(mascotReducer, {
    ...initialState,
    dragEnabled: config.drag ?? false,
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the reducer is showing, kept in step with it so a rejected (lower-priority) line does not
  // cancel the shown line's expiry timer and replace it with its own (shorter) one.
  const shownRef = useRef<{ currentMessage: string | null; messagePriority: number }>({
    currentMessage: null,
    messagePriority: 0,
  });

  const dispatch = useCallback((action: MascotAction) => {
    if (action.type === 'SET_MESSAGE') {
      if (!acceptsMessage(shownRef.current, action.payload.priority)) return;
      shownRef.current = {
        currentMessage: action.payload.text,
        messagePriority: action.payload.priority,
      };
    } else if (action.type === 'CLEAR_MESSAGE') {
      shownRef.current = { currentMessage: null, messagePriority: 0 };
    }
    if (action.type === 'SET_MESSAGE' || action.type === 'CLEAR_MESSAGE') {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    rawDispatch(action);
    if (action.type === 'SET_MESSAGE') {
      // TTS 正在说话（口型有能量）时不收起气泡，说完 1.5s 后再收
      const expire = () => {
        if (Date.now() - lastSpokeAt < 1500 || bubbleHover.on) {
          timerRef.current = setTimeout(expire, 400);
          return;
        }
        shownRef.current = { currentMessage: null, messagePriority: 0 };
        rawDispatch({ type: 'CLEAR_MESSAGE' });
      };
      timerRef.current = setTimeout(expire, action.payload.timeout || 3000);
    }
  }, []);

  // e2e / 调试：当前模型名
  useEffect(() => {
    document.documentElement.dataset.mascotModel = state.modelName ?? '';
  }, [state.modelName]);

  // 外部（托盘 / e2e）可通过 window 事件打开浮层
  useEffect(() => {
    const openPanel = (e: Event) => {
      const panel = (e as CustomEvent<{ panel?: string }>).detail?.panel;
      if (panel === 'interaction' || panel === 'credits' || panel === 'motions')
        rawDispatch({ type: 'SET_PANEL', payload: panel });
    };
    window.addEventListener('mascot:open-panel', openPanel);
    return () => {
      window.removeEventListener('mascot:open-panel', openPanel);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    // 旧版本可能记着商店 / 导入的角色：已不再支持，清掉，始终用 Nomi
    clearSelectedModel();
    void loadCatalog(fetch).then((models) => {
      if (alive) rawDispatch({ type: 'SET_MODEL_LIST', payload: models });
    });
    return () => {
      alive = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const currentModel = state.modelList.find((m) => m.name === state.modelName);

  useEffect(() => {
    setActiveCharacter(currentModel?.name ?? state.modelName, currentModel?.config);
  }, [currentModel, state.modelName]);

  return (
    <MascotContext.Provider value={{ state, dispatch, config, currentModel }}>
      {children}
    </MascotContext.Provider>
  );
};

export const useMascot = (): MascotContextType => {
  const ctx = useContext(MascotContext);
  if (ctx === undefined) throw new Error('useMascot must be used within a MascotProvider');
  return ctx;
};
