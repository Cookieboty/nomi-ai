// Package codingcli：本机现在有没有能委派的编程助手（装了且设置里允许委派）。
//
// 委派服务（cli/delegate）启动时 Set 一个判断函数；提示词（派不派、后台 Nomi、工作区）与工具门控
// 读 Available：没有编程助手时不提供 delegate_to_cli，提示词改成让 Nomi 自己写代码、跑命令。
// 单独成包是为了让 delegate / tasks / desktop 都能读，不互相引用。
package codingcli

import "sync/atomic"

var probe atomic.Pointer[func() bool]

// Set：登记判断函数；nil = 取消登记（按有处理）
func Set(fn func() bool) {
	if fn == nil {
		probe.Store(nil)
		return
	}
	probe.Store(&fn)
}

// Available：没登记过（测试、委派服务没起来）按有处理，保持原来的提示词；判断函数 panic 按没有
func Available() (ok bool) {
	p := probe.Load()
	if p == nil {
		return true
	}
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	return (*p)()
}
