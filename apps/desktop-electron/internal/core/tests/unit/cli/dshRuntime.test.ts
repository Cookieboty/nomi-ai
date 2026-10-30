import { dshRuntimeProblem } from '../../../src/cli/detect';

describe('dshRuntimeProblem', () => {
  it('accepts Node 24+', () => {
    expect(dshRuntimeProblem('24.0.0')).toBeNull();
    expect(dshRuntimeProblem('25.1.2')).toBeNull();
  });
  it('flags older or missing Node', () => {
    expect(dshRuntimeProblem('22.11.0')).toEqual({ nodeVersion: '22.11.0', required: 24 });
    expect(dshRuntimeProblem(null)).toEqual({ nodeVersion: null, required: 24 });
  });
});
