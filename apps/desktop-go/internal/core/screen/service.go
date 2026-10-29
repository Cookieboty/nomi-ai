// Package screen = packages/core/src/screen/ScreenService.ts：
// 图片发送前的检查（契约 screen.checkSend，走 PermissionBroker 的云端告知 / 仅本地模式），
// 以及启动时清掉旧版本留下的屏幕记忆目录。
package screen

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
)

type Logger interface {
	Warn(m string, x any)
}

// Deps = ScreenDeps；desktop 只用到 providerFor('chat') 与 broker.checkSend
type Deps struct {
	Root        string // 旧版本的 userData/screen-memory 目录
	Logger      Logger
	ProviderFor func(role desktop.Role) *desktop.Provider
	// CheckSend = broker.checkSend："" = null（放行）| local_only | user_denied
	CheckSend func(p *desktop.Provider, signal context.Context, what string) string
}

type Service struct {
	d Deps
	// LegacyPurged：启动时清理旧数据的异步任务，完成后关闭（测试可等）
	LegacyPurged <-chan struct{}
}

func New(d Deps) *Service {
	ch := make(chan struct{})
	s := &Service{d: d, LegacyPurged: ch}
	// 异步删除：旧截图目录可能很大，不在主进程启动路径上做同步 IO
	go func() {
		defer close(ch)
		if err := os.RemoveAll(d.Root); err != nil {
			d.Logger.Warn("清理旧屏幕记忆失败", fmt.Sprint(err))
		}
	}()
	return s
}

// CheckSend：发送图片前：云端告知 / 仅本地模式
func (s *Service) CheckSend() string {
	r := s.d.CheckSend(s.d.ProviderFor("chat"), nil, i18n.T("electron.common.images-attached"))
	if r == "" {
		return "ok"
	}
	return r
}

// Register 挂 screen.checkSend（contract/media.ts）；get 返回 nil = 服务不可用
func Register(r *contract.Router, get func() *Service) {
	r.Call("screen.checkSend", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		s := get()
		if s == nil {
			return nil, &contract.Error{Code: "UNAVAILABLE", Message: "Service 'screen' is not available"}
		}
		return s.CheckSend(), nil
	})
}
