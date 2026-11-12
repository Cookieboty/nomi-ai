package computer

import (
	"context"
	"time"
)

// hostProbeTTL：设置页状态里「本机 agent-desktop 版本 + 系统权限」的缓存。
// 打开 Computer Use 页会读这两项；Windows 上每次都是一次 .cmd 启动。控制台窗口抢焦点时
// 页面的 focus 监听会立刻再读，形成死循环。缓存盖住这一小段，检查更新 / 重新检查权限会绕过。
const hostProbeTTL = 4 * time.Second

type hostProbeResult struct {
	at      time.Time
	bin     string
	version string
	perms   map[string]string
}

type hostProbeFlight struct {
	gen  uint64
	bin  string
	done chan struct{}
	res  hostProbeResult
	ok   bool
}

func clonePerms(in map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range in {
		out[k] = v
	}
	return out
}

func (s *Service) probeTTL() time.Duration {
	if s.hostProbeTTL > 0 {
		return s.hostProbeTTL
	}
	return hostProbeTTL
}

func (s *Service) invalidateHostProbe() {
	s.hostMu.Lock()
	s.hostGen++
	s.hostRes = hostProbeResult{}
	s.hostMu.Unlock()
}

// hostProbe：本机版本和系统权限。fresh 时丢掉缓存重新读（检查更新、重新检查权限）。
// 同一时刻只有一次在读，短时间内的重复请求复用结果。
func (s *Service) hostProbe(ctx context.Context, bin string, fresh bool) (string, map[string]string) {
	ttl := s.probeTTL()
	for {
		if ctx.Err() != nil {
			return "", map[string]string{}
		}
		s.hostMu.Lock()
		gen := s.hostGen
		if fresh {
			s.hostGen++
			gen = s.hostGen
			s.hostRes = hostProbeResult{}
			fresh = false
		} else if s.hostRes.bin == bin && !s.hostRes.at.IsZero() && time.Since(s.hostRes.at) < ttl {
			ver, perms := s.hostRes.version, clonePerms(s.hostRes.perms)
			s.hostMu.Unlock()
			return ver, perms
		} else if s.hostFly != nil && s.hostFly.bin == bin && s.hostFly.gen == gen {
			f := s.hostFly
			s.hostMu.Unlock()
			select {
			case <-f.done:
				if f.ok {
					return f.res.version, clonePerms(f.res.perms)
				}
				continue
			case <-ctx.Done():
				return "", map[string]string{}
			}
		}
		f := &hostProbeFlight{gen: gen, bin: bin, done: make(chan struct{})}
		s.hostFly = f
		s.hostMu.Unlock()

		ver := s.InstalledVersion(ctx)
		perms := s.Permissions(ctx)
		if perms == nil {
			perms = map[string]string{}
		}
		res := hostProbeResult{at: time.Now(), bin: bin, version: ver, perms: perms}
		s.hostMu.Lock()
		if ctx.Err() == nil && s.hostGen == gen {
			s.hostRes = res
			f.ok = true
			f.res = res
		}
		if s.hostFly == f {
			s.hostFly = nil
		}
		s.hostMu.Unlock()
		close(f.done)
		if ctx.Err() != nil {
			return "", map[string]string{}
		}
		return ver, clonePerms(perms)
	}
}
