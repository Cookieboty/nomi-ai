const registerSchemesAsPrivileged = jest.fn();
jest.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged, handle: jest.fn() },
  app: { getPath: () => '/tmp', isPackaged: false },
}));

import { registerAppSchemePrivileges } from '../../src/schemePrivileges';

describe('registerAppSchemePrivileges', () => {
  it('registers cdmodel:// and chat-asset:// in ONE call (a second call would replace the first)', () => {
    registerAppSchemePrivileges();
    expect(registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    const schemes = registerSchemesAsPrivileged.mock.calls[0][0] as Array<{
      scheme: string;
      privileges: Record<string, boolean>;
    }>;
    expect(schemes.map((s) => s.scheme).sort()).toEqual(['cdmodel', 'chat-asset']);
    for (const s of schemes) {
      expect(s.privileges).toMatchObject({ standard: true, secure: true, supportFetchAPI: true });
    }
  });
});
