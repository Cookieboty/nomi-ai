import type * as ChildProcess from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

jest.mock('node:child_process', () => ({ execFileSync: jest.fn() }));

import { updateWindowsPath } from '../../../src/gateway/windowsPath';

const native = jest.requireActual<typeof ChildProcess>('node:child_process');
const ps = (source: string) =>
  native
    .execFileSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(
          "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); " +
            source,
          'utf16le',
        ).toString('base64'),
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    )
    .trim();

(process.platform === 'win32' ? describe : describe.skip)(
  'Windows user PATH registry update',
  () => {
    it.each(['String', 'ExpandString'])(
      'preserves raw variables and %s type using an isolated registry key',
      (kind) => {
        const key = `Software\\NomiTests\\terminal-path-${randomUUID()}`;
        const directory = 'C:\\Nomi test & (中文)\\bin';
        jest.mocked(execFileSync).mockImplementation((file, args, options) => {
          const forwarded = [...(args as string[])];
          const encoded = forwarded.indexOf('-EncodedCommand') + 1;
          const source = Buffer.from(forwarded[encoded], 'base64').toString('utf16le');
          if (!source.includes("CreateSubKey('Environment')"))
            throw new Error('Unexpected registry target');
          // 只让真实 PowerShell 执行独立测试键，绝不写当前用户 Environment。
          forwarded[encoded] = Buffer.from(
            source.replace("CreateSubKey('Environment')", `CreateSubKey('${key}')`),
            'utf16le',
          ).toString('base64');
          return native.execFileSync(file, forwarded, options);
        });
        const read = () =>
          JSON.parse(
            ps(
              `$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}'); try { @{ value=$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); kind=[string]$k.GetValueKind('Path') } | ConvertTo-Json -Compress } finally { $k.Dispose() }`,
            ),
          );
        try {
          ps(
            `$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}'); $k.SetValue('Path','%USERPROFILE%\\custom;C:\\tools',[Microsoft.Win32.RegistryValueKind]::${kind}); $k.Dispose()`,
          );
          expect(updateWindowsPath(directory, true)).toBe(true);
          expect(read()).toEqual({ value: `%USERPROFILE%\\custom;C:\\tools;${directory}`, kind });
          expect(updateWindowsPath(directory.toUpperCase(), true)).toBe(false);
          expect(updateWindowsPath(directory, false)).toBe(true);
          expect(read()).toEqual({ value: '%USERPROFILE%\\custom;C:\\tools', kind });
          expect(updateWindowsPath(directory, false)).toBe(false);
        } finally {
          ps(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${key}', $false)`);
        }
      },
      30_000,
    );
  },
);
