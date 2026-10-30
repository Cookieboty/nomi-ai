# @nomi-ai/host-ports

宿主端口定义（纯类型）：内核经这些接口使用平台能力，不直接 import `electron`。设计见 [docs/design/core-host-decoupling.md](../../docs/design/core-host-decoupling.md) §6、§9。

| 端口            | 对应现有调用                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `paths`         | `app.getPath('userData' / 'temp' / 'home' / 'documents')`、`getAppPath`、`process.resourcesPath` |
| `app`           | `app.getName` / `getVersion` / `getLocale` / `isPackaged`                                        |
| `secrets`       | `safeStorage`（同步，策略留在内核的 `secretStorage` / `SecretCipher`）                           |
| `dialogs`       | `dialog.showOpenDialog` / `showSaveDialog` / `showErrorBox`                                      |
| `shell`         | `shell.openExternal` / `openPath` / `showItemInFolder`                                           |
| `clipboard`     | `clipboard.readText` / `writeText` / `read`（图片）                                              |
| `screenCapture` | `desktopCapturer` + `screen`                                                                     |
| `power`         | `powerMonitor.getSystemIdleTime`、`suspend` / `resume`                                           |
| `lifecycle`     | `app.whenReady` / `quit` / `exit`、`before-quit` / `activate`                                    |
| `appearance`    | `nativeTheme.shouldUseDarkColors` / `themeSource`、`updated`                                     |
| `notifications` | `Notification`（图标由宿主给）                                                                   |
| `image`         | `nativeImage.createFromBuffer` / `getSize` / `resize` / `toPNG` / `toJPEG`                       |
| `processes`     | `utilityProcess.fork`（子进程经 `process.parentPort` 收发消息）                                  |
| `windows`       | 声明式：打开 / 聚焦 / 隐藏界面，不暴露窗口对象                                                   |
| `capabilities`  | 宿主特有能力声明（透明窗口、托盘、灵动岛等）                                                     |

实现：Electron 在 `apps/desktop-electron/src/host/electronPorts.ts`，无界面宿主在 `@nomi-ai/host-node`。
