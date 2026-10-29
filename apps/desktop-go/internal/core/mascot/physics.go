package mascot

// 桌面物理：packages/host-electron/src/mascot/desktopPhysics.ts 的逐行移植（纯函数）。
// 坐标为屏幕像素、y 向下；窗口位置 (x, y) 为左上角；box 为角色在窗口内的包围盒。

import "math"

// Rect / CharacterBox 与 mascotSize 的 AreaRect / MascotBox 同形
type Rect = AreaRect
type CharacterBox = MascotBox

type BodyState struct {
	X           float64  `json:"x"`
	Y           float64  `json:"y"`
	VX          float64  `json:"vx"`
	VY          float64  `json:"vy"`
	Mode        string   `json:"mode"`
	WalkTargetX *float64 `json:"walkTargetX,omitempty"`
}

type PhysicsConfig struct {
	Gravity, Restitution, GroundFriction, AirDrag, MaxSpeed, BounceThreshold, WalkSpeed, FallGap float64
}

var DefaultPhysics = PhysicsConfig{Gravity: 1550, Restitution: 0.18, GroundFriction: 11, AirDrag: 0.4,
	MaxSpeed: 4200, BounceThreshold: 320, WalkSpeed: 70, FallGap: 24}

type PhysicsEnv struct {
	WorkAreas []Rect
	Box       CharacterBox
	Gravity   bool
	Cfg       *PhysicsConfig
}

// PhysicsEvent：type = land | bounce | wall | arrive（字段按 JS 对象的键序输出）
type PhysicsEvent struct {
	Type  string   `json:"type"`
	Side  string   `json:"side,omitempty"`
	Speed *float64 `json:"speed,omitempty"`
}

func fp(v float64) *float64 { return &v }

func clampf(v, lo, hi float64) float64 { return math.Min(hi, math.Max(lo, v)) }

// jsSign = Math.sign
func jsSign(v float64) float64 {
	switch {
	case math.IsNaN(v):
		return v
	case v > 0:
		return 1
	case v < 0:
		return -1
	}
	return v // ±0
}

// jsHypot = V8 Math.hypot（按最大值缩放 + Kahan 补偿求和），保证与 Node 逐位一致
func jsHypot(vals ...float64) float64 {
	max := 0.0
	nan := false
	for _, v := range vals {
		a := math.Abs(v)
		if math.IsInf(a, 1) {
			return math.Inf(1)
		}
		if math.IsNaN(a) {
			nan = true
		} else if a > max {
			max = a
		}
	}
	if nan {
		return math.NaN()
	}
	if max == 0 {
		return 0
	}
	sum, comp := 0.0, 0.0
	for _, v := range vals {
		n := math.Abs(v) / max
		summand := n*n - comp
		pre := sum + summand
		comp = (pre - sum) - summand
		sum = pre
	}
	return math.Sqrt(sum) * max
}

// jsExp = fdlibm e_exp（V8 ieee754::exp 同源），避开 amd64 汇编实现的末位差异
func jsExp(x float64) float64 {
	const (
		ln2Hi     = 6.93147180369123816490e-01
		ln2Lo     = 1.90821492927058770002e-10
		log2e     = 1.44269504088896338700e+00
		overflow  = 7.09782712893383973096e+02
		underflow = -7.45133219101941108420e+02
		nearZero  = 1.0 / (1 << 28)
		p1        = 1.66666666666666657415e-01
		p2        = -2.77777777770155933842e-03
		p3        = 6.61375632143793436117e-05
		p4        = -1.65339022054652515390e-06
		p5        = 4.13813679705723846039e-08
	)
	switch {
	case math.IsNaN(x):
		return x
	case x > overflow:
		return math.Inf(1)
	case x < underflow:
		return 0
	case -nearZero < x && x < nearZero:
		return 1 + x
	}
	var k int
	switch {
	case x < 0:
		k = int(log2e*x - 0.5)
	case x > 0:
		k = int(log2e*x + 0.5)
	}
	hi := x - float64(k)*ln2Hi
	lo := float64(k) * ln2Lo
	r := hi - lo
	t := r * r
	c := r - t*(p1+t*(p2+t*(p3+t*(p4+t*p5))))
	y := 1 - ((lo - (r*c)/(2-c)) - hi)
	return math.Ldexp(y, k)
}

// AreaUnder：角色水平中心所在工作区；竖直叠放取最上面一块；都不在时取水平距离最近的
func AreaUnder(areas []Rect, cx float64) Rect {
	if len(areas) == 0 {
		return Rect{X: 0, Y: 0, Width: 1920, Height: 1080}
	}
	var inside []Rect
	for _, a := range areas {
		if cx >= a.X && cx < a.X+a.Width {
			inside = append(inside, a)
		}
	}
	if len(inside) > 0 {
		best := inside[0]
		for _, b := range inside[1:] {
			if b.Y < best.Y {
				best = b
			}
		}
		return best
	}
	dist := func(a Rect) float64 {
		if cx < a.X {
			return a.X - cx
		}
		return cx - (a.X + a.Width)
	}
	best := areas[0]
	for _, b := range areas[1:] {
		if dist(b) < dist(best) {
			best = b
		}
	}
	return best
}

func FloorFor(areas []Rect, cx float64) float64 {
	a := AreaUnder(areas, cx)
	return a.Y + a.Height
}

func GroundY(floor, bottom float64) float64 { return floor - math.Ceil(bottom-1e-6) }

func HorizontalBounds(areas []Rect) (float64, float64) {
	if len(areas) == 0 {
		return 0, 1920
	}
	min, max := math.Inf(1), math.Inf(-1)
	for _, a := range areas {
		min = math.Min(min, a.X)
		max = math.Max(max, a.X+a.Width)
	}
	return min, max
}

func OnFloor(s BodyState, env PhysicsEnv) bool {
	cx := s.X + (env.Box.Left+env.Box.Right)/2
	return math.Abs(s.Y+env.Box.Bottom-FloorFor(env.WorkAreas, cx)) <= 1
}

func ClampToWorld(s BodyState, env PhysicsEnv) BodyState {
	min, max := HorizontalBounds(env.WorkAreas)
	x := clampf(s.X, min-env.Box.Left, max-env.Box.Right)
	cx := x + (env.Box.Left+env.Box.Right)/2
	area := AreaUnder(env.WorkAreas, cx)
	y := clampf(s.Y, area.Y-env.Box.Top, GroundY(area.Y+area.Height, env.Box.Bottom))
	s.X, s.Y = x, y
	return s
}

func (env PhysicsEnv) cfg() PhysicsConfig {
	if env.Cfg != nil {
		return *env.Cfg
	}
	return DefaultPhysics
}

// Step：单个固定步长
func Step(s BodyState, dt float64, env PhysicsEnv) (BodyState, []PhysicsEvent) {
	cfg := env.cfg()
	events := []PhysicsEvent{}
	if s.Mode == "held" {
		return s, events
	}
	min, max := HorizontalBounds(env.WorkAreas)
	cx := func() float64 { return s.X + (env.Box.Left+env.Box.Right)/2 }
	floor := func() float64 { return FloorFor(env.WorkAreas, cx()) }
	feet := func() float64 { return s.Y + env.Box.Bottom }

	if s.Mode == "walking" {
		target := s.X
		if s.WalkTargetX != nil {
			target = *s.WalkTargetX
		}
		dir := jsSign(target - s.X)
		s.VX = dir * cfg.WalkSpeed
		s.VY = 0
		nx := s.X + s.VX*dt
		if dir == 0 || (dir > 0 && nx >= target) || (dir < 0 && nx <= target) {
			s.X = target
			s.VX = 0
			s.Mode = "idle"
			s.WalkTargetX = nil
			events = append(events, PhysicsEvent{Type: "arrive"})
		} else {
			s.X = nx
		}
	}

	if s.Mode == "idle" || s.Mode == "walking" {
		if feet() < floor()-cfg.FallGap {
			if env.Gravity {
				s.Mode = "falling"
			} else {
				s.VX *= jsExp(-cfg.GroundFriction * dt)
				s.VY *= jsExp(-cfg.GroundFriction * dt)
				s.X += s.VX * dt
				s.Y += s.VY * dt
			}
		} else if feet() > floor() || (s.Mode == "idle" && feet() < floor()) {
			s.Y = GroundY(floor(), env.Box.Bottom)
		}
		if s.Mode == "idle" && env.Gravity {
			s.VX *= jsExp(-cfg.GroundFriction * dt)
			if math.Abs(s.VX) < 2 {
				s.VX = 0
			}
			s.X += s.VX * dt
		}
	}

	if s.Mode == "falling" {
		s.VY += cfg.Gravity * dt
		drag := jsExp(-cfg.AirDrag * dt)
		s.VX *= drag
		sp := jsHypot(s.VX, s.VY)
		if sp > cfg.MaxSpeed {
			s.VX *= cfg.MaxSpeed / sp
			s.VY *= cfg.MaxSpeed / sp
		}
		s.X += s.VX * dt
		s.Y += s.VY * dt
		f := floor()
		if feet() >= f {
			s.Y = GroundY(f, env.Box.Bottom)
			impact := s.VY
			if impact > cfg.BounceThreshold {
				s.VY = -impact * cfg.Restitution
				s.VX *= 0.8
				events = append(events, PhysicsEvent{Type: "bounce", Speed: fp(impact)})
			} else {
				s.VY = 0
				s.Mode = "idle"
				events = append(events, PhysicsEvent{Type: "land", Speed: fp(impact)})
			}
		}
		area := AreaUnder(env.WorkAreas, cx())
		if s.Y+env.Box.Top < area.Y {
			s.Y = area.Y - env.Box.Top
			s.VY = math.Abs(s.VY) * cfg.Restitution
		}
	}

	if s.X+env.Box.Left < min {
		s.X = min - env.Box.Left
		if s.VX < 0 {
			events = append(events, PhysicsEvent{Type: "wall", Side: "left", Speed: fp(-s.VX)})
			s.VX = -s.VX * cfg.Restitution
		}
		if s.Mode == "walking" {
			s.WalkTargetX = fp(s.X)
		}
	} else if s.X+env.Box.Right > max {
		s.X = max - env.Box.Right
		if s.VX > 0 {
			events = append(events, PhysicsEvent{Type: "wall", Side: "right", Speed: fp(s.VX)})
			s.VX = -s.VX * cfg.Restitution
		}
		if s.Mode == "walking" {
			s.WalkTargetX = fp(s.X)
		}
	}
	return s, events
}

// Advance：固定步长推进（fixedDt 1/120，maxSteps 24），返回剩余累积时间
func Advance(s BodyState, acc float64, env PhysicsEnv) (BodyState, float64, []PhysicsEvent) {
	return AdvanceWith(s, acc, env, 1.0/120, 24)
}

func AdvanceWith(s BodyState, accumulator float64, env PhysicsEnv, fixedDt float64, maxSteps int) (BodyState, float64, []PhysicsEvent) {
	events := []PhysicsEvent{}
	acc := math.Min(accumulator, fixedDt*float64(maxSteps))
	for acc >= fixedDt-1e-9 {
		var ev []PhysicsEvent
		s, ev = Step(s, fixedDt, env)
		events = append(events, ev...)
		acc = math.Max(0, acc-fixedDt)
	}
	return s, acc, events
}

// VelocityTracker：拖拽速度估计（指数加权）
type VelocityTracker struct {
	VX, VY    float64
	smoothing float64
	last      *struct{ x, y, t float64 }
}

func NewVelocityTracker() *VelocityTracker { return &VelocityTracker{smoothing: 0.06} }

func (v *VelocityTracker) Reset(x, y, t float64) {
	v.last = &struct{ x, y, t float64 }{x, y, t}
	v.VX, v.VY = 0, 0
}

func (v *VelocityTracker) Sample(x, y, t float64) {
	if v.last == nil {
		v.Reset(x, y, t)
		return
	}
	dt := (t - v.last.t) / 1000
	if dt <= 0 {
		return
	}
	k := 1 - jsExp(-dt/v.smoothing)
	v.VX += ((x-v.last.x)/dt - v.VX) * k
	v.VY += ((y-v.last.y)/dt - v.VY) * k
	v.last = &struct{ x, y, t float64 }{x, y, t}
}

func (v *VelocityTracker) Release(t float64) (float64, float64) {
	return v.ReleaseWith(t, DefaultPhysics.MaxSpeed, 80)
}

func (v *VelocityTracker) ReleaseWith(t, maxSpeed, maxAge float64) (float64, float64) {
	if v.last == nil || t-v.last.t > maxAge {
		return 0, 0
	}
	sp := jsHypot(v.VX, v.VY)
	k := 1.0
	if sp > maxSpeed {
		k = maxSpeed / sp
	}
	return v.VX * k, v.VY * k
}

// PickWanderTarget：在当前工作区内随机挑一个点（80–360px）
func PickWanderTarget(s BodyState, env PhysicsEnv, rnd func() float64) float64 {
	const minDist, maxDist = 80.0, 360.0
	cxOff := (env.Box.Left + env.Box.Right) / 2
	area := AreaUnder(env.WorkAreas, s.X+cxOff)
	lo := area.X - env.Box.Left
	hi := area.X + area.Width - env.Box.Right
	dir := 1.0
	if rnd() < 0.5 {
		dir = -1
	}
	dist := minDist + rnd()*(maxDist-minDist)
	t := s.X + dir*dist
	if t < lo || t > hi {
		t = s.X - dir*dist
	}
	return clampf(t, lo, hi)
}

func AnchorOnBoxChange(s BodyState, prev *CharacterBox, next CharacterBox, areas []Rect) BodyState {
	if prev == nil || (s.Mode != "idle" && s.Mode != "walking") {
		return s
	}
	cxPrev := s.X + (prev.Left+prev.Right)/2
	if math.Abs(s.Y+prev.Bottom-FloorFor(areas, cxPrev)) > 2 {
		return s
	}
	cx := s.X + (next.Left+next.Right)/2
	s.Y = GroundY(FloorFor(areas, cx), next.Bottom)
	s.VY = 0
	return s
}

func ShouldFallAtStart(s BodyState, env PhysicsEnv) bool {
	if !env.Gravity || s.Mode != "idle" {
		return false
	}
	cfg := env.cfg()
	cx := s.X + (env.Box.Left+env.Box.Right)/2
	return FloorFor(env.WorkAreas, cx)-(s.Y+env.Box.Bottom) > cfg.FallGap
}
