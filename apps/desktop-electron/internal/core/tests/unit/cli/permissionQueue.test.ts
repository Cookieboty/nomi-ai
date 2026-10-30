jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import {
  approvePlanMode,
  executePlanEvent,
  isExecutePlanId,
  isExitPlanTool,
  markApprovePlanIfExit,
} from '../../../src/cli/harness/permissionQueue';

describe('permissionQueue (PR3)', () => {
  it('detects ExitPlanMode tool name variants', () => {
    expect(isExitPlanTool('ExitPlanMode')).toBe(true);
    expect(isExitPlanTool('exit_plan_mode')).toBe(true);
    expect(isExitPlanTool('exit-plan-mode')).toBe(true);
    expect(isExitPlanTool('ExitPlanMode: ship')).toBe(true);
    expect(isExitPlanTool('Bash')).toBe(false);
  });

  it('marks permission events as approve-plan', () => {
    const marked = markApprovePlanIfExit({
      type: 'permission',
      id: '1',
      summary: 'ExitPlanMode: do it',
      toolName: 'ExitPlanMode',
    });
    expect(marked).toMatchObject({ kind: 'approve-plan', toolName: 'ExitPlanMode' });
    const already = markApprovePlanIfExit({
      type: 'permission',
      id: '2',
      summary: 'Bash',
      kind: 'tool',
    });
    expect(already).toMatchObject({ kind: 'tool' });
  });

  it('maps approve-plan choices to modes', () => {
    expect(approvePlanMode('acceptEdits')).toBe('acceptEdits');
    expect(approvePlanMode('manual')).toBe('manual');
    expect(approvePlanMode('deny')).toBeNull();
  });

  it('builds execute-plan local events', () => {
    const ev = executePlanEvent('t1', 'run it', 1000);
    expect(isExecutePlanId(ev.id)).toBe(true);
    expect(ev.kind).toBe('approve-plan');
    expect(ev.toolName).toBe('execute_plan');
    expect(ev.expiresAt).toBeGreaterThan(Date.now());
  });
});
