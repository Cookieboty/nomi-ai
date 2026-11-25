// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ConversationView } from '../src/components/Conversation';
import type { GatewayState } from '../src/services/gatewayClient';
import type { HarnessTabMessage } from '../src/services/harnessClient';
import {
  clearModelSwitch,
  derivedSwitchTip,
  modelSwitchTipFor,
  noteModelSwitch,
  resolveMainChatSwitchTip,
  useModelSwitch,
} from '../src/services/modelSwitchTip';
import { refLabel } from '../src/services/nomiModel';
import type { ChatMessage } from '../src/types/chat';
import type { ConvMessage } from '../src/types/conversation';
import { fromChatMessage, fromHarnessMessage } from '../src/utils/convAdapters';
import { ENDPOINT_NAME } from '../src/utils/endpointBadge';

afterEach(cleanup);

const assistant = (over: Partial<ConvMessage> = {}): ConvMessage => ({
  id: 'a1',
  role: 'assistant',
  text: 'hi',
  at: 1,
  ...over,
});

describe('助手消息上的模型', () => {
  it('agent 消息：端点名 + 主进程记下的模型；旧消息只有端点名', () => {
    const m: HarnessTabMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'x',
      timestamp: 1,
      model: 'deepseek/deepseek-v4.1-flash',
    };
    expect(fromHarnessMessage(m, 'grok')).toMatchObject({
      label: 'Grok',
      model: 'deepseek/deepseek-v4.1-flash',
    });
    const old = fromHarnessMessage(
      { id: 'm2', role: 'assistant', content: 'x', timestamp: 1 },
      'grok',
    );
    expect(old.label).toBe('Grok');
    expect(old).not.toHaveProperty('model');
    // 用户消息不带
    expect(
      fromHarnessMessage({ id: 'u', role: 'user', content: 'q', timestamp: 1, model: 'x' }, 'grok'),
    ).not.toHaveProperty('model');
  });

  it('Nomi 消息：端点名 Nomi + 发送时的模型', () => {
    const m = { id: 'n1', role: 'assistant', content: 'x', timestamp: 1, modelId: 'DeepSeek / v4' };
    expect(fromChatMessage(m as ChatMessage)).toMatchObject({
      label: 'Nomi',
      model: 'DeepSeek / v4',
    });
  });

  it('元信息里显示模型，无障碍名保留完整模型名', () => {
    const { getByTestId, queryByTestId } = render(
      <ConversationView
        scopeId="s"
        messages={[assistant({ label: 'Grok', model: 'amux/openai/gpt-6.1-sol' })]}
        phase="idle"
      />,
    );
    const el = getByTestId('conv-msg-model');
    expect(el.textContent?.replace(/\s+/g, '')).toBe('amux/openai/gpt-6.1-sol');
    expect(el.getAttribute('title')).toBeNull();
    expect(el.getAttribute('aria-label')).toContain('amux/openai/gpt-6.1-sol');
    expect(queryByTestId('conv-msg-actual-model')).toBeNull();
  });

  it('上游返回了另一个模型时，页脚在请求的模型后面标出实际名称', () => {
    const { getByTestId, getByRole } = render(
      <ConversationView
        scopeId="s"
        messages={[
          assistant({
            label: 'Claude Code',
            model: 'maas/Aerith-fable-5',
            responseModel: 'claude-fable-5',
          }),
        ]}
        phase="idle"
      />,
    );
    const el = getByTestId('conv-msg-model');
    expect(el.textContent).toContain('maas/Aerith-fable-5');
    expect(el.textContent).toContain('→');
    expect(el.textContent).toContain('claude-fable-5');
    expect(el.getAttribute('title')).toBeNull();
    expect(el.getAttribute('aria-label')).toContain('claude-fable-5');
    const actual = getByTestId('conv-msg-actual-model');
    expect(actual.textContent).toContain('claude-fable-5');
    expect(actual.getAttribute('title')).toBeNull();
    expect(getByRole('tooltip').textContent).toContain('claude-fable-5');
  });
});

describe('会话中途换模型的弱提示', () => {
  const msgs = [{ role: 'user' }, { role: 'assistant', model: 'gw/main' }];

  it('agents：切过模型才提示；切回最后一条助手消息的模型不提示；还没有助手回复不提示', () => {
    expect(modelSwitchTipFor(msgs, undefined)).toBeNull();
    expect(modelSwitchTipFor(msgs, 'gw/other')).toBe('gw/other');
    expect(modelSwitchTipFor(msgs, 'gw/main')).toBeNull();
    expect(modelSwitchTipFor([{ role: 'user' }], 'gw/other')).toBeNull();
    // 旧消息没记模型：切过就提示；空串 = 回到默认模型
    expect(modelSwitchTipFor([{ role: 'assistant' }], 'gw/other')).toBe('gw/other');
    expect(modelSwitchTipFor(msgs, '')).toBe('');
  });

  it('切换记录：换模型后有，发送后清掉', () => {
    const { result } = renderHook(() => useModelSwitch('tab-1'));
    expect(result.current).toBeUndefined();
    act(() => noteModelSwitch('tab-1', 'gw/other'));
    expect(result.current).toBe('gw/other');
    act(() => clearModelSwitch('tab-1'));
    expect(result.current).toBeUndefined();
  });

  it('Nomi：当前模型与最后一条助手消息的模型不同才提示', () => {
    expect(derivedSwitchTip(msgs, 'gw/other')).toBe('gw/other');
    expect(derivedSwitchTip(msgs, 'gw/main')).toBeNull();
    expect(derivedSwitchTip(msgs, undefined)).toBeNull();
    expect(derivedSwitchTip([{ role: 'assistant' }], 'gw/other')).toBeNull();
    // Nomi 默认不剥离思考档位后缀
    expect(derivedSwitchTip([{ role: 'assistant', model: 'qwen-max' }], 'qwen')).toBe('qwen');
  });

  it('原生思考档位变体：同基础模型按默认档位或调整深度不误判，换基础模型正常提示', () => {
    const neonHigh = [{ role: 'user' }, { role: 'assistant', model: 'gemini-4-neon-high' }];
    // 走默认思考档位（effort 未显式设置）：gemini-4-neon-high 与 gemini-4-neon 为同一模型
    expect(derivedSwitchTip(neonHigh, 'gemini-4-neon', { ignoreEffortSuffix: true })).toBeNull();
    // 仅在同一模型下调整思考档位：不提示换模型
    expect(
      derivedSwitchTip(neonHigh, 'gemini-4-neon', {
        ignoreEffortSuffix: true,
        effort: 'medium',
      }),
    ).toBeNull();
    expect(
      derivedSwitchTip(neonHigh, 'gemini-4-neon-low', { ignoreEffortSuffix: true }),
    ).toBeNull();
    // 切换到另一个基础模型：正常提示
    expect(derivedSwitchTip(neonHigh, 'gemini-4-carbon', { ignoreEffortSuffix: true })).toBe(
      'gemini-4-carbon',
    );
    // 非思考后缀变体：orchestrator-neon 与 orchestrator-argon 属于不同模型
    expect(
      derivedSwitchTip(
        [{ role: 'assistant', model: 'gemini-pro-orchestrator-neon' }],
        'gemini-pro-orchestrator-argon',
        { ignoreEffortSuffix: true },
      ),
    ).toBe('gemini-pro-orchestrator-argon');
    // 含 `/` 的第三方模型不剥离后缀，避免把 dashscope/qwen-max 误当作 dashscope/qwen
    expect(
      derivedSwitchTip([{ role: 'assistant', model: 'dashscope/qwen-max' }], 'dashscope/qwen', {
        ignoreEffortSuffix: true,
      }),
    ).toBe('dashscope/qwen');
    // Agents 标签 / 抽屉：带后缀回复切回基础模型时不提示，切别的模型时提示
    expect(modelSwitchTipFor(neonHigh, 'gemini-4-neon', { ignoreEffortSuffix: true })).toBeNull();
    expect(modelSwitchTipFor(neonHigh, 'claude-opus-5-5', { ignoreEffortSuffix: true })).toBe(
      'claude-opus-5-5',
    );
  });

  it('跨 CLI 与托管 API 综合判断：同底座同模型不误报，底座或模型任一变化均提示', () => {
    const gateway = {
      providers: [
        {
          id: 'maas',
          name: 'MAAS',
          enabled: true,
          urls: {},
          models: [
            { id: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash', enabled: true },
            { id: 'deepseek-v4', label: 'deepseek-v4', enabled: true },
          ],
        },
      ],
      clients: { nomi: { models: { main: 'maas/deepseek-v4.1-flash' } } },
    } as unknown as GatewayState;
    const norm = (m: string) => refLabel(gateway, m);

    const nomiApiReply = [
      { role: 'user' },
      {
        role: 'assistant',
        label: 'Nomi',
        model: 'maas/deepseek-v4.1-flash',
        raw: { runtimeBackend: 'api' },
      },
    ];
    // 1. 托管 API（Nomi）下消息存原始 ref、当前选择器显示格式化名「MAAS · deepseek-v4.1-flash」→ 同一模型，绝不误报
    expect(
      resolveMainChatSwitchTip({
        messages: nomiApiReply,
        isCliBackend: false,
        gatewayModelLabel: 'MAAS · deepseek-v4.1-flash',
        gatewayModelRef: 'maas/deepseek-v4.1-flash',
        normalizeModel: norm,
        defaultModelLabel: '默认模型',
      }),
    ).toBeNull();

    // 2. Nomi 同 CLI 内切到另一个模型 → 提示新模型显示名（kind = model）
    expect(
      resolveMainChatSwitchTip({
        messages: nomiApiReply,
        isCliBackend: false,
        gatewayModelLabel: 'MAAS · deepseek-v4',
        gatewayModelRef: 'maas/deepseek-v4',
        normalizeModel: norm,
        defaultModelLabel: '默认模型',
      }),
    ).toEqual({ kind: 'model', target: 'MAAS · deepseek-v4' });

    const agyReply = [
      { role: 'user' },
      {
        role: 'assistant',
        label: 'Antigravity',
        model: 'gemini-4-neon-high',
        raw: { runtimeBackend: 'antigravity' },
      },
    ];
    // 3. Antigravity 同底座保留思考默认档位 / 调整档位 → 不误报；切同 CLI 不同模型 → 只提示新模型（kind = model）
    expect(
      resolveMainChatSwitchTip({
        messages: agyReply,
        isCliBackend: true,
        currentBackend: 'antigravity',
        managedModel: 'gemini-4-neon',
        managedSource: 'local',
        normalizeModel: norm,
        defaultModelLabel: '默认模型',
      }),
    ).toBeNull();
    expect(
      resolveMainChatSwitchTip({
        messages: agyReply,
        isCliBackend: true,
        currentBackend: 'antigravity',
        managedModel: 'cli-default',
        managedSource: 'local',
        normalizeModel: norm,
        defaultModelLabel: '默认模型',
      }),
    ).toBeNull();
    expect(
      resolveMainChatSwitchTip({
        messages: agyReply,
        isCliBackend: true,
        currentBackend: 'antigravity',
        managedModel: 'gemini-4-carbon',
        managedSource: 'local',
        normalizeModel: norm,
        defaultModelLabel: '默认模型',
      }),
    ).toEqual({ kind: 'model', target: 'gemini-4-carbon' });

    // 4. 跨 CLI + 不同模型 → 附带新 CLI 与新模型（kind = runtime）
    expect(
      resolveMainChatSwitchTip({
        messages: agyReply,
        isCliBackend: false,
        gatewayModelLabel: 'MAAS · deepseek-v4.1-flash',
        gatewayModelRef: 'maas/deepseek-v4.1-flash',
        normalizeModel: norm,
        defaultModelLabel: '默认模型',
      }),
    ).toEqual({ kind: 'runtime', target: 'Nomi · MAAS · deepseek-v4.1-flash' });
    expect(
      resolveMainChatSwitchTip({
        messages: nomiApiReply,
        isCliBackend: true,
        currentBackend: 'antigravity',
        managedModel: 'gemini-4-neon',
        managedSource: 'local',
        normalizeModel: norm,
        defaultModelLabel: '默认模型',
      }),
    ).toEqual({ kind: 'runtime', target: 'Antigravity · gemini-4-neon' });
    expect(
      resolveMainChatSwitchTip({
        messages: agyReply,
        isCliBackend: true,
        currentBackend: 'claude',
        managedModel: 'cli-default',
        managedSource: 'local',
        normalizeModel: norm,
        defaultModelLabel: '默认模型',
      }),
    ).toEqual({ kind: 'runtime', target: 'Claude Code · 默认模型' });

    // 5. 跨 CLI 但使用第三方源的同一个模型 → 底座已变，仍需附带新 CLI 提示（kind = runtime）
    expect(
      resolveMainChatSwitchTip({
        messages: nomiApiReply,
        isCliBackend: true,
        currentBackend: 'codex',
        managedModel: 'maas/deepseek-v4.1-flash',
        managedSource: 'thirdParty',
        normalizeModel: norm,
        defaultModelLabel: '默认模型',
      }),
    ).toEqual({ kind: 'runtime', target: 'Codex · MAAS · deepseek-v4.1-flash' });

    const codexThirdPartyReply = [
      { role: 'user' },
      {
        role: 'assistant',
        label: 'Codex',
        model: 'maas/deepseek-v4.1-flash',
        raw: { runtimeBackend: 'codex' },
      },
    ];
    expect(
      resolveMainChatSwitchTip({
        messages: codexThirdPartyReply,
        isCliBackend: false,
        gatewayModelLabel: 'MAAS · deepseek-v4.1-flash',
        gatewayModelRef: 'maas/deepseek-v4.1-flash',
        normalizeModel: norm,
        defaultModelLabel: '默认模型',
      }),
    ).toEqual({ kind: 'runtime', target: 'Nomi · MAAS · deepseek-v4.1-flash' });

    // 从 CLI 切回尚未配置网关模型的 Nomi → 仅提示新底座名（kind = runtime）
    expect(
      resolveMainChatSwitchTip({
        messages: agyReply,
        isCliBackend: false,
        gatewayModelLabel: '',
        gatewayModelRef: null,
        normalizeModel: norm,
        defaultModelLabel: '默认模型',
      }),
    ).toEqual({ kind: 'runtime', target: 'Nomi' });
  });

  it('视图：区分模型切换与底座切换文案，空闲时显示，运行中隐藏，空串显示为默认模型', () => {
    const base = { scopeId: 'x', messages: [assistant()], phase: 'idle' as const };
    const { rerender, queryByTestId } = render(
      <ConversationView {...base} modelSwitchTip="gw/other" />,
    );
    const tip = queryByTestId('conv-model-switch-tip');
    expect(tip?.getAttribute('data-switch-kind')).toBe('model');
    expect(tip?.textContent).toContain('gw/other');
    expect(tip?.textContent).toContain('换模型');
    expect(tip?.getAttribute('role')).toBe('note');
    const modelText = tip?.textContent ?? '';

    rerender(<ConversationView {...base} modelSwitchTip={{ kind: 'model', target: 'gw/next' }} />);
    const structuredModelTip = queryByTestId('conv-model-switch-tip');
    expect(structuredModelTip?.getAttribute('data-switch-kind')).toBe('model');
    expect(structuredModelTip?.textContent).toContain('gw/next');
    expect(structuredModelTip?.textContent).toContain('换模型');

    rerender(
      <ConversationView
        {...base}
        modelSwitchTip={{ kind: 'runtime', target: 'Antigravity · gemini-4-neon' }}
      />,
    );
    const runtimeTip = queryByTestId('conv-model-switch-tip');
    expect(runtimeTip?.getAttribute('data-switch-kind')).toBe('runtime');
    expect(runtimeTip?.textContent).toContain('已切换底座到 Antigravity · gemini-4-neon');
    expect(runtimeTip?.textContent).toContain('换底座');
    expect(runtimeTip?.textContent).not.toBe(modelText);

    rerender(<ConversationView {...base} modelSwitchTip="gw/other" phase="running" />);
    expect(queryByTestId('conv-model-switch-tip')).toBeNull();
    rerender(<ConversationView {...base} modelSwitchTip="" />);
    expect(queryByTestId('conv-model-switch-tip')?.textContent).toContain('默认模型');
    rerender(<ConversationView {...base} modelSwitchTip={null} />);
    expect(queryByTestId('conv-model-switch-tip')).toBeNull();
  });
});

describe('回复来源图标', () => {
  it.each(Object.entries(ENDPOINT_NAME))(
    '为 %s 的回复来源名称配上对应图标且不重复朗读',
    (backend, label) => {
      const r = render(
        <ConversationView scopeId="s" messages={[assistant({ label })]} phase="idle" />,
      );
      const source = r.getByTestId('conv-agent-label');
      expect(source.textContent).toBe(label);
      expect(
        source.querySelector(`[data-endpoint="${backend}"]`)?.getAttribute('aria-hidden'),
      ).toBe('true');
    },
  );

  it('托管主对话消息：按 runtimeBackend 映射来源名称，非 CLI 回退 Nomi，并透传模型', () => {
    const agyMsg: ChatMessage = {
      id: 'm-agy',
      role: 'assistant',
      content: 'ok',
      timestamp: 10,
      runtimeBackend: 'antigravity',
      modelId: 'gemini-4-neon-medium',
    };
    expect(fromChatMessage(agyMsg)).toMatchObject({
      label: ENDPOINT_NAME.antigravity,
      model: 'gemini-4-neon-medium',
    });

    const apiMsg: ChatMessage = {
      id: 'm-api',
      role: 'assistant',
      content: 'ok',
      timestamp: 11,
      runtimeBackend: 'api',
      modelId: 'gw/main',
    };
    expect(fromChatMessage(apiMsg)).toMatchObject({
      label: ENDPOINT_NAME.nomi,
      model: 'gw/main',
    });
  });
});
