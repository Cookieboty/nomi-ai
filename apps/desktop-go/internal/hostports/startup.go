package hostports

import (
	"log"
	"time"
)

// ProcStart ≈ 进程进入 Go 运行时的时刻（包初始化）；之前的耗时（dyld / Gatekeeper / syspolicyd）
// 由 bench 用 epoch 与自身 t0 相减得出。
var ProcStart = time.Now()

// Stage 打启动剖析日志：[startup] <name> +<ms since ProcStart> epoch=<unix ms>
func Stage(name string) {
	now := time.Now()
	log.Printf("[startup] %s +%dms epoch=%d", name, now.Sub(ProcStart).Milliseconds(), now.UnixMilli())
}
