package migrate

import (
	"context"
	"log"
	"time"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/security"
)

// Gate = 2.0.4 密钥迁移完成屏障（D-B11-12）。窗口先出，迁移（与它唯一的钥匙串授权框）随后在后台跑；
// 读密钥的一方（网关 Init / 供应商存储加载 / 读密钥的契约过程）先 Wait。
type Gate struct {
	done chan struct{}
	res  Result
}

// StartSecrets：after 关闭（或 fallback 超时）后在后台跑 RunSecrets，再跑 then（网关 init 等），
// 最后放行。没有待迁密钥（全新安装 / 已迁过 / 无 2.0.4 数据）时走快路径：当场 then、立即放行。
func StartSecrets(userData string, box security.SecretBox, ss security.ElectronSafeStorage,
	after <-chan struct{}, fallback time.Duration, then func(Result)) *Gate {
	g := &Gate{done: make(chan struct{})}
	if !Pending(userData) {
		g.res = RunSecrets(userData, box, ss)
		if then != nil {
			then(g.res)
		}
		close(g.done)
		return g
	}
	go func() {
		defer close(g.done)
		select {
		case <-after:
		case <-time.After(fallback):
			log.Printf("[migrate] window not shown after %s; migrating secrets anyway", fallback)
		}
		g.res = RunSecrets(userData, box, ss)
		if then != nil {
			then(g.res)
		}
	}()
	return g
}

// Pending：标记里是否还有没迁的密钥
func Pending(userData string) bool {
	return readMarker(userData).SecretsPending
}

// Done：迁移（含 then）完成时关闭
func (g *Gate) Done() <-chan struct{} { return g.done }

// Wait 阻塞到迁移完成（或 ctx 取消）
func (g *Gate) Wait(ctx context.Context) error {
	select {
	case <-g.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Result：Done 之后有效
func (g *Gate) Result() Result {
	<-g.done
	return g.res
}
