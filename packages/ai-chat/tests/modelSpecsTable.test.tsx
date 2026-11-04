// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelLimitsGroups } from '../src/components/ModelsPage/ModelLimitsGroups';
import type { GatewayModel } from '../src/services/gatewayClient';

afterEach(cleanup);

describe('供应商详情的模型规格表', () => {
  const models: GatewayModel[] = [
    {
      id: 'Aerith-opus-5.5',
      enabled: true,
      like: 'claude-sonnet-4.6',
      effective: {
        ctx: 200_000,
        maxOutput: 128_000,
        source: 'catalog',
        maxOutputSource: 'catalog',
        longContext: { standard: 200_000, full: 1_000_000, on: false },
      },
    },
    { id: 'off-model', enabled: false },
  ];

  it('每个启用的模型一行：按哪个模型处理 / 上下文 / 标准窗口 / 输出上限', () => {
    const setModel = vi.fn();
    const r = render(<ModelLimitsGroups models={models} setModel={setModel} />);
    expect(r.getAllByRole('row')).toHaveLength(2);
    expect(r.queryByTestId('pd-model-like-off-model')).toBeNull();
    // 长上下文可开：上下文的自动值是完整窗口，标准窗口的自动值来自目录
    expect(r.getByTestId('pd-model-ctx-Aerith-opus-5.5').getAttribute('placeholder')).toContain(
      '1M',
    );
    expect(
      r.getByTestId('pd-model-standard-Aerith-opus-5.5').getAttribute('placeholder'),
    ).toContain('200K');
    fireEvent.change(r.getByTestId('pd-model-standard-Aerith-opus-5.5'), {
      target: { value: '256000' },
    });
    expect(setModel).toHaveBeenCalledWith('Aerith-opus-5.5', { ctxStandard: 256_000 });
  });
});
