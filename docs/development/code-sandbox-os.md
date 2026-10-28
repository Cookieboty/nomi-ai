# 代码沙箱 OS 隔离（CodeSandbox）

实现：`packages/core/src/sandbox/platformSandbox.ts`，由 `CodeSandbox.run` 的 Python 路径调用。

| 平台    | 真实隔离                                                  | 回落                                            |
| ------- | --------------------------------------------------------- | ----------------------------------------------- |
| macOS   | `sandbox-exec` + 内置 Seatbelt（可写仅 tmp，默认禁网）    | 无二进制 → `sandbox:'fallback'`，裸 `python -I` |
| Linux   | `bwrap`（只读 `/usr`/`/lib`…，可写 tmp，`--unshare-net`） | 未安装 bubblewrap → `fallback`                  |
| Windows | 本阶段无 FS jail；结果 `sandbox:'none'`                   | 与今日行为相同；Job Object 未接                 |

JavaScript 仍用 Node `--permission`（`sandbox:'node-permission'`）。

UI：`p3tools` 在平台沙箱可用时一次确认 + `PYTHON_OS_SANDBOX`；不可用时保持二次确认 + `PYTHON_NO_ISOLATION`。结果字段 `sandbox` 供上层展示。
