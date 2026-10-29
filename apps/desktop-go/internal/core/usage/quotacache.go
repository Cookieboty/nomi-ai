package usage

// 对应 quotaCache.ts：额度缓存——按账号身份隔离 + 分层降级 + 60 秒节流。
//
//   - 身份：非敏感指纹（见 quotaidentity）。指纹变了 = 换号，旧值立刻清掉；
//   - 降级：只有「暂时性失败」才保留旧值并标 stale；「认证失效类」清掉旧值；
//   - 节流：同一个来源两次真实拉取至少间隔 TTL（60 秒），期间直接返回 throttled；同时只会有一个进行中的拉取。
//
// 所有方法都在 jsrt 锁内调用（= Node 主线程）。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/jsrt"
)

const QuotaTTLMs = 60_000

// AuthFailReason = 'not-signed-in' | 'expired' | 'denied' | 'custom-provider' | 'api-account'
type AuthFailReason = string

// TransientReason = 'timeout' | 'output-limit' | 'spawn-failed' | 'not-installed' | 'bad-output' | 'no-limits' | 'network' | 'unsupported'
type TransientReason = string

// FetchOutcome：Kind = 'ok' | 'transient' | 'auth'。
// ok：Reading + Identity（nil = undefined/null）；transient / auth：Reason。
type FetchOutcome struct {
	Kind     string
	Reading  *QuotaReading
	Identity *string
	Reason   string
}

// RefreshResult：State = 'ok' | 'throttled' | 'superseded' | 'transient'(Reason, Stale) | 'auth'(Reason)。
type RefreshResult struct {
	State  string
	Reason string
	Stale  bool
}

// ToObj：Node 字面量形状（{ state } / { state, reason, stale } / { state, reason }）。
func (r RefreshResult) ToObj() *util.Obj {
	o := util.NewObj("state", r.State)
	switch r.State {
	case "transient":
		o.Set("reason", r.Reason)
		o.Set("stale", r.Stale)
	case "auth":
		o.Set("reason", r.Reason)
	}
	return o
}

func (r RefreshResult) MarshalJSON() ([]byte, error) { return []byte(util.Stringify(r.ToObj())), nil }

// QuotaSnapshot = snapshot() 的返回值 { identity, value }。
type QuotaSnapshot struct {
	Identity *string
	Value    *QuotaReading
}

func (s QuotaSnapshot) ToObj() *util.Obj {
	var id any
	if s.Identity != nil {
		id = *s.Identity
	}
	return util.NewObj("identity", id, "value", s.Value.ToObj())
}

func (s QuotaSnapshot) MarshalJSON() ([]byte, error) { return []byte(util.Stringify(s.ToObj())), nil }

// IdentityQuotaCache = class IdentityQuotaCache。
type IdentityQuotaCache struct {
	identity      *string
	value         *QuotaReading
	stale         bool
	lastAttemptAt float64
	inflight      *jsrt.Promise[RefreshResult]
	// 代际：clear / 换号 / 认证失效都会 +1。拉取开始时捕获，返回时对不上就丢弃
	gen         int
	inflightGen int
	onChange    func()

	now   func() float64
	ttlMs float64
}

// NewIdentityQuotaCache：now 为 nil = Date.now；ttlMs <= 0 不会出现在 Node（默认 QUOTA_TTL_MS），此处 0 = 默认。
func NewIdentityQuotaCache(now func() float64, ttlMs float64) *IdentityQuotaCache {
	if now == nil {
		now = nowMs
	}
	if ttlMs == 0 {
		ttlMs = QuotaTTLMs
	}
	return &IdentityQuotaCache{now: now, ttlMs: ttlMs}
}

func (c *IdentityQuotaCache) SetOnChange(fn func()) { c.onChange = fn }

func (c *IdentityQuotaCache) changed() {
	if c.onChange == nil {
		return
	}
	defer func() { _ = recover() }() // 落盘失败不影响内存里的值
	c.onChange()
}

// Snapshot：落盘用（不含 stale 标记）；nil = null。
func (c *IdentityQuotaCache) Snapshot() *QuotaSnapshot {
	if c.value == nil {
		return nil
	}
	return &QuotaSnapshot{Identity: cloneStr(c.identity), Value: c.value.Clone()}
}

func cloneStr(p *string) *string {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func truthyStr(p *string) bool { return p != nil && *p != "" }

// Restore：启动时恢复上一次的值；身份已知且不同（换了号）就不恢复。
func (c *IdentityQuotaCache) Restore(identity *string, value *QuotaReading) bool {
	if truthyStr(c.identity) && truthyStr(identity) && *c.identity != *identity {
		return false
	}
	if truthyStr(identity) {
		c.identity = cloneStr(identity)
	}
	c.value = value.Clone()
	c.stale = false
	return true
}

// Get = { ...value, ...(stale ? { stale: true } : {}) }。
func (c *IdentityQuotaCache) Get() *QuotaReading {
	if c.value == nil {
		return nil
	}
	r := c.value.Clone()
	if c.stale {
		r.Stale = true
	}
	return r
}

func (c *IdentityQuotaCache) IsStale() bool { return c.value != nil && c.stale }

func (c *IdentityQuotaCache) CurrentIdentity() *string { return c.identity }

func (c *IdentityQuotaCache) Clear() {
	c.gen++
	had := c.value != nil || truthyStr(c.identity)
	c.value = nil
	c.stale = false
	c.identity = nil
	// 用户清空之后立即刷新：不能被清空前那次拉取的 60 秒节流挡住（#45）
	c.lastAttemptAt = 0
	if had {
		c.changed()
	}
}

// ObserveIdentity：已知身份变化时换号清旧值。
func (c *IdentityQuotaCache) ObserveIdentity(fp *string) bool {
	if !truthyStr(fp) {
		return false
	}
	if truthyStr(c.identity) && *c.identity != *fp {
		c.gen++
		c.value = nil
		c.stale = false
		c.identity = cloneStr(fp)
		c.lastAttemptAt = 0 // 新账号不受旧账号的节流限制
		c.changed()
		return true
	}
	was := c.identity
	c.identity = cloneStr(fp)
	if was == nil || *was != *fp {
		c.changed()
	}
	return false
}

// RetryInMs：距离下一次允许真实拉取还有多久（ms，0 = 现在就可以）。
func (c *IdentityQuotaCache) RetryInMs() float64 {
	d := c.lastAttemptAt + c.ttlMs - c.now()
	if d > 0 {
		return d
	}
	return 0
}

// Refresh：load 里 panic / 返回的 promise 拒绝 = transient spawn-failed。
func (c *IdentityQuotaCache) Refresh(fp *string, load func() *jsrt.Promise[FetchOutcome]) *jsrt.Promise[RefreshResult] {
	c.ObserveIdentity(fp)
	// 只复用同一代际的进行中拉取
	if c.inflight != nil && c.inflightGen == c.gen {
		return c.inflight
	}
	if c.RetryInMs() > 0 {
		return jsrt.Resolved(RefreshResult{State: "throttled"})
	}
	c.lastAttemptAt = c.now()
	gen := c.gen
	var p *jsrt.Promise[RefreshResult]
	p = jsrt.Async(func() (RefreshResult, error) {
		// p.finally(() => { if (this.inflight === p) this.inflight = null; })
		defer func() {
			if c.inflight == p {
				c.inflight = nil
			}
		}()
		out, err := callLoad(load)
		if err != nil {
			out = FetchOutcome{Kind: "transient", Reason: "spawn-failed"}
		}
		// 开始之后被清空 / 换号过：一律不再回写
		if gen != c.gen {
			return RefreshResult{State: "superseded"}, nil
		}
		switch out.Kind {
		case "ok":
			c.ObserveIdentity(out.Identity)
			c.value = out.Reading
			c.stale = false
			c.changed()
			return RefreshResult{State: "ok"}, nil
		case "transient":
			if c.value != nil {
				c.stale = true
			}
			return RefreshResult{State: "transient", Reason: out.Reason, Stale: c.value != nil}, nil
		}
		c.gen++
		c.value = nil
		c.stale = false
		c.identity = nil
		c.changed()
		return RefreshResult{State: "auth", Reason: out.Reason}, nil
	})
	c.inflight = p
	c.inflightGen = gen
	if p.Settled() {
		// load 同步抛错时 async 函数同步跑完：finally 回调仍在微任务里才清 inflight（同 JS）
		jsrt.QueueMicrotask(func() {
			if c.inflight == p {
				c.inflight = nil
			}
		})
	}
	return p
}

func callLoad(load func() *jsrt.Promise[FetchOutcome]) (out FetchOutcome, err error) {
	var pr *jsrt.Promise[FetchOutcome]
	func() {
		defer func() {
			if r := recover(); r != nil {
				err = jsrt.JSThrow{Message: "load threw"}
			}
		}()
		pr = load()
	}()
	if err != nil {
		return
	}
	return jsrt.Await(pr)
}
