---
'@nomi-ai/contract': minor
'@nomi-ai/i18n': patch
---

feat(contract): 新增 `harness.sandboxReply`（回答沙箱授权请求：session / always / deny）、`desktop.setCliSandbox`、`desktop.removeCliSandboxAllow`；标签状态多了 `sandboxPending`，标签列表状态多了 `sandbox`（on / off / unsupported），桌面状态多了 `cliSandbox`、`cliSandboxSupported`、`cliSandboxAllow`；补上相应的中英文案。/ Adds `harness.sandboxReply` (answer a sandbox request: session / always / deny), `desktop.setCliSandbox` and `desktop.removeCliSandboxAllow`; tab state gains `sandboxPending`, the tabs state gains `sandbox` (on / off / unsupported) and the desktop state gains `cliSandbox`, `cliSandboxSupported` and `cliSandboxAllow`; matching zh / en copy.
