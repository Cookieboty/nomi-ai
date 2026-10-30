package hostports

import (
	"fmt"
	"os"
	"sync"
	"time"
)

// ProcStart ≈ 进程进入 Go 运行时的时刻（包初始化）；之前的耗时（dyld / Gatekeeper / syspolicyd）
// 由 bench 用 epoch 与自身 t0 相减得出。
var ProcStart = time.Now()

// Stage 打启动剖析日志：[startup] <name> +<ms since ProcStart> epoch=<unix ms>
func Stage(name string) {
	now := time.Now()
	// 直接写 stderr（不经 log / LoggerService）：打包后 LoggerService 不往控制台输出 INFO，而 ci/bench/bench.py
	// 要从程序输出里解析这些阶段
	fmt.Fprintf(os.Stderr, "[startup] %s +%dms epoch=%d\n", name, now.Sub(ProcStart).Milliseconds(), now.UnixMilli())
	stageMu.Lock()
	if c, ok := stageCh[name]; ok {
		select {
		case <-c:
		default:
			close(c)
		}
	} else {
		c := make(chan struct{})
		close(c)
		stageCh[name] = c
	}
	stageMu.Unlock()
}

var (
	stageMu sync.Mutex
	stageCh = map[string]chan struct{}{}
)

// Reached：Stage(name) 打过之后关闭的 channel（D-B11-12：桌面角色窗口出来后再跑密钥迁移）
func Reached(name string) <-chan struct{} {
	stageMu.Lock()
	defer stageMu.Unlock()
	c, ok := stageCh[name]
	if !ok {
		c = make(chan struct{})
		stageCh[name] = c
	}
	return c
}
