package fleet

// 调度策略：Nomi 同时派出去跑的编程助手 / 后台任务的上限，三档由用户在 Agent 看板里选（存盘）。
// 省资源、均衡是固定上限：同步委派与持续任务（含后台委派）合计同时运行的个数（两边都设成这个数，
// 各自判断时把对方在跑的算进来：delegate.Service.SetSharedLoad / tasks.Runtime.SetSharedLoad），
// 超出的排队（看板「待进行」标 queueReason: slot），不会被拒绝。用户自己开的标签、外部终端 / IDE 里的会话不算。
// 全速不设个数上限，按资源放行：内存压力偏高 / 紧张、或整机 CPU 到 FullSpeedCPUHold 时新的先排着（Holding，
// 不看自动处理开关），缓下来后自动开始；已经在跑的不打断。

// Policy：当前的调度策略
type Policy struct {
	// Mode：saver 省资源 / balanced 均衡（默认）/ max 全速
	Mode string `json:"mode"`
	// MaxParallel：委派与后台任务合计同时运行的个数；0 = 不设上限，按 CPU 与内存放行
	MaxParallel int `json:"maxParallel"`
}

const DefaultPolicy = "balanced"

// FullSpeedCPUHold：「全速」档里整机 CPU（0–100）到这个值时，新的任务先排着
const FullSpeedCPUHold = 85

// Policies：三档的具体数值（视图也按这个顺序列）
var Policies = []Policy{
	{Mode: "saver", MaxParallel: 5},
	{Mode: "balanced", MaxParallel: 10},
	{Mode: "max", MaxParallel: 0},
}

// PolicyOf：模式 → 策略；不认识的按默认
func PolicyOf(mode string) Policy {
	for _, p := range Policies {
		if p.Mode == mode {
			return p
		}
	}
	return PolicyOf(DefaultPolicy)
}

// Policy：当前的调度策略
func (s *Service) Policy() Policy {
	s.mu.Lock()
	defer s.mu.Unlock()
	return PolicyOf(s.policy)
}

// ApplyPolicy：把当前策略交给执行方（装配完成后调一次，之后每次 SetPolicy 都会调）
func (s *Service) ApplyPolicy() {
	s.mu.Lock()
	fn := s.d.ApplyPolicy
	p := PolicyOf(s.policy)
	s.mu.Unlock()
	if fn != nil {
		fn(p)
	}
}

// SetPolicy：换调度策略（存盘并立即生效）；不认识的模式按默认。换档后不再扣着的，马上放行排队的
func (s *Service) SetPolicy(mode string) State {
	p := PolicyOf(mode)
	wasHolding := s.Holding()
	s.mu.Lock()
	s.policy = p.Mode
	s.mu.Unlock()
	s.saveSettings()
	s.ApplyPolicy()
	if wasHolding && !s.Holding() {
		s.release()
	}
	return s.State()
}
