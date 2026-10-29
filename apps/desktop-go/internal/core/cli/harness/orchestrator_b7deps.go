package harness

// STUB（b7 填充）：b7o 的长驻会话代码（orchestrator_claude/acp/codex/dsh_grok.go）调用、归 b7 所有的方法。
// 签名约定同 orchestrator_live.go；b7 移植时直接在这里填实现（或搬到各自文件并删掉这里的同名桩）。
// 桩一律 panic(b7Stub)，b7o 的 golden 测试遇到它跳过（见 orchestrator_live_parity_test.go）。

import ()

// b7Stub：未移植的 b7 方法 panic 的值。
type b7Stub string

func notPortedB7(name string) { panic(b7Stub("orchestrator: " + name + " not ported yet (b7)")) }
