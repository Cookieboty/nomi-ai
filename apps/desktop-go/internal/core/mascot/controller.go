package mascot

// MascotWindowController：packages/host-electron/src/mascot/MascotWindowController.ts 与
// host/windowBounds.ts 的逐行移植。窗口、时钟、定时器、光标、显示器经接口注入，便于回放 Node 录下的轨迹。

import (
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/hostports"
	"log"
	"math"
	"sync"
)

type InteractionConfig struct {
	ClickThrough bool `json:"clickThrough"`
	Gravity      bool `json:"gravity"`
	Wander       bool `json:"wander"`
	Reactions    bool `json:"reactions"`
	GlobalLook   bool `json:"globalLook"`
}

var DefaultInteraction = InteractionConfig{ClickThrough: true, Gravity: false, Wander: false, Reactions: true, GlobalLook: true}

// IRect：窗口整数矩形（Electron Rectangle）
type IRect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Win = 控制器用到的 BrowserWindow 子集
type Win interface {
	IsDestroyed() bool
	GetPosition() (int, int)
	GetSize() (int, int)
	GetBounds() IRect
	SetBounds(r IRect)
	SetPosition(x, y int)
	IsResizable() bool
	SetResizable(b bool)
	IsVisible() bool
	IsMinimized() bool
	// SetIgnoreMouseEvents(true, {forward:true}) / (false)
	SetIgnoreMouseEvents(ignore bool)
	SetShape(rects []IRect)
}

// Host = 宿主环境：performance.now、setTimeout、screen.*、事件总线
type Host interface {
	Now() float64
	// After 安排一次回调（ms）；返回取消函数
	After(ms float64, f func()) (cancel func())
	Cursor() (float64, float64)
	Displays() []Rect
	Publish(ch string, payload any)
	Info(msg string, data any)
	Warn(msg string, data any)
}

type ScaleHooks struct {
	Get  func() float64
	Save func(scale float64)
}

const (
	tickMS       = 1000.0 / 60
	idleTickMS   = 120.0
	hiddenTickMS = 1000.0
	activeHoldMS = 400.0
	cursorMS     = 1000.0 / 30
)

// IsStaleGeometry：包围盒是按缩放前的窗口尺寸量的（容差 1px）
func IsStaleGeometry(vw, vh any, curW, curH float64, stale *Size) bool {
	w, ok1 := vw.(float64)
	h, ok2 := vh.(float64)
	if stale == nil || !ok1 || !ok2 {
		return false
	}
	near := func(a, b float64) bool { return math.Abs(a-b) <= 1 }
	if near(w, curW) && near(h, curH) {
		return false
	}
	return near(w, stale.Width) && near(h, stale.Height)
}

// SetWindowBounds = host/windowBounds.setWindowBounds
func SetWindowBounds(win Win, b IRect, platform string, unlock bool) {
	locked := unlock && (platform == "win32" || platform == "linux") && !win.IsResizable()
	if locked {
		win.SetResizable(true)
	}
	defer func() {
		if locked {
			win.SetResizable(false)
		}
	}()
	if !unlock {
		win.SetBounds(b)
		return
	}
	req := b
	n := 1
	if platform == "win32" {
		n = 3
	}
	for i := 0; i < n; i++ {
		win.SetBounds(req)
		if platform != "win32" {
			break
		}
		a := win.GetBounds()
		dx, dy, dw, dh := a.X-b.X, a.Y-b.Y, a.Width-b.Width, a.Height-b.Height
		if dx == 0 && dy == 0 && dw == 0 && dh == 0 {
			break
		}
		big := false
		for _, v := range []int{dx, dy, dw, dh} {
			if v > 8 || v < -8 {
				big = true
			}
		}
		if big {
			break
		}
		req = IRect{X: req.X - dx, Y: req.Y - dy, Width: max(1, req.Width-dw), Height: max(1, req.Height-dh)}
	}
}

// MoveWindowTo = host/windowBounds.moveWindowTo
func MoveWindowTo(win Win, x, y int, size Size, platform string, verifySize, positionOnly bool) {
	if platform != "win32" || positionOnly {
		win.SetPosition(x, y)
		return
	}
	r := IRect{X: x, Y: y, Width: int(size.Width), Height: int(size.Height)}
	if !verifySize {
		SetWindowBounds(win, r, platform, false)
		return
	}
	a := win.GetBounds()
	drifted := math.Abs(float64(a.Width)-size.Width) > 1 || math.Abs(float64(a.Height)-size.Height) > 1
	SetWindowBounds(win, r, platform, drifted)
}

type pt struct{ X, Y float64 }

type Controller struct {
	mu       sync.Mutex
	win      Win
	host     Host
	rnd      func() float64
	hooks    *ScaleHooks
	platform string

	cfg            InteractionConfig
	body           BodyState
	box            *CharacterBox
	staleSize      *Size
	workAreas      []Rect
	cancel         func()
	lastActivityAt float64
	last           float64
	acc            float64
	frame          int
	ignoring       bool
	hitKnown       bool
	shapeRects     int
	drag           *pt
	dragPoint      *pt
	appliedDrag    *pt
	lastDragMoveAt float64
	dragWinSize    *Size
	dragUnlocked   bool
	requested      *pt
	tracker        *VelocityTracker
	prevV          pt
	nextWanderAt   float64
	lastCursor     pt
	lastCursorAt   float64
	scale, pref    float64
	started        bool
}

func NewController(win Win, host Host, rnd func() float64, hooks *ScaleHooks, platform string) *Controller {
	return &Controller{win: win, host: host, rnd: rnd, hooks: hooks, platform: platform,
		cfg: DefaultInteraction, body: BodyState{Mode: "idle"}, tracker: NewVelocityTracker(),
		lastDragMoveAt: math.Inf(-1), lastCursor: pt{math.NaN(), math.NaN()},
		scale: DefaultMascotScale, pref: DefaultMascotScale}
}

func (c *Controller) dragFromOSCursor() bool { return c.platform == "win32" }
func (c *Controller) shapeMode() bool        { return c.platform == "linux" }

func numOf(v any) (float64, bool) {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// Started：控制器是否在运行（窗口重建时沿用同一控制器）
func (c *Controller) Started() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.started
}

func (c *Controller) Start() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.started = true
	c.refreshDisplays()
	w, _ := c.win.GetSize()
	c.scale = RoundMascotScale((float64(w) - float64(2*MascotPad.X)) / MascotBase.Width)
	c.pref = c.scale
	if c.hooks != nil && c.hooks.Get != nil {
		c.pref = c.hooks.Get()
	}
	// Windows 上 Start 早于窗口实化，GetSize 返回 0x0：此时按创建窗口时同一口径（偏好缩放）取当前缩放，
	// 否则会被夹到最小 0.3（246x265，而 Electron 2.0.4 为 330x355）
	if w <= 2*int(MascotPad.X) {
		c.scale = FitMascotScale(c.pref, MaxMascotScale)
	}
	x, y := c.win.GetPosition()
	_, h0 := c.win.GetSize()
	hostports.Stage("mascot-start")
	log.Printf("[mascot] start size=%dx%d scale=%.2f pref=%v areas=%+v", w, h0, c.scale, c.pref, c.workAreas)
	c.requested = &pt{float64(x), float64(y)}
	c.body = BodyState{X: float64(x), Y: float64(y), Mode: "idle"}
	c.last = c.host.Now()
	c.lastActivityAt = c.last
	c.nextWanderAt = c.last + 15000
	c.schedule(tickMS)
}

// DisplaysChanged = screen 的 display-added / removed / metrics-changed
func (c *Controller) DisplaysChanged() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.started {
		return
	}
	c.refreshDisplays()
	want := FitMascotScale(c.pref, c.capNow())
	if want != c.scale && !c.win.IsDestroyed() {
		c.applyScale(want, false, true)
	}
}

// Wake = 窗口 show / restore
func (c *Controller) Wake() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.started || c.win.IsDestroyed() {
		return
	}
	c.last = c.host.Now()
	c.lastActivityAt = c.last
	c.schedule(tickMS)
}

func (c *Controller) schedule(delay float64) {
	if c.cancel != nil {
		c.cancel()
	}
	c.cancel = c.host.After(delay, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.tick()
	})
}

func (c *Controller) Dispose() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dispose()
}

func (c *Controller) dispose() {
	if c.cancel != nil {
		c.cancel()
	}
	c.cancel = nil
	c.started = false
	if c.dragUnlocked && !c.win.IsDestroyed() {
		c.win.SetResizable(false)
		c.dragUnlocked = false
	}
}

func (c *Controller) Config() InteractionConfig {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cfg
}

func (c *Controller) ReportHit(hit any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.setHit(hit == true)
}

func (c *Controller) ReportShape(rects any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.setShape(rects)
}

func (c *Controller) ReportGeometry(box any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.setBox(box)
}

func (c *Controller) BeginDrag(sx, sy any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	x, okx := numOf(sx)
	y, oky := numOf(sy)
	var p *pt
	if okx && oky {
		p = &pt{x, y}
	}
	c.dragStart(p)
}

func (c *Controller) MoveDrag(sx, sy any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	x, okx := numOf(sx)
	y, oky := numOf(sy)
	if c.drag == nil || !okx || !oky {
		return
	}
	if c.dragFromOSCursor() {
		cx, cy := c.host.Cursor()
		c.updateDragPosition(pt{cx, cy}, false)
	} else {
		c.updateDragPosition(pt{x, y}, false)
	}
}

func (c *Controller) EndDrag() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dragEnd()
}

func (c *Controller) WanderNow() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.startWander()
}

func (c *Controller) ScaleSet(v any) ScaleState {
	c.mu.Lock()
	defer c.mu.Unlock()
	n, ok := numOf(v)
	if !ok {
		return c.scaleState()
	}
	return c.setScale(n)
}

func (c *Controller) ScaleStep(dir any) ScaleState {
	c.mu.Lock()
	defer c.mu.Unlock()
	d := 1
	if f, ok := dir.(float64); ok && f == -1 {
		d = -1
	}
	return c.setScale(StepMascotScale(c.scale, d, c.capNow()))
}

func (c *Controller) ScaleWheel(deltaY, deltaMode any) ScaleState {
	c.mu.Lock()
	defer c.mu.Unlock()
	dy, ok := numOf(deltaY)
	if !ok {
		return c.scaleState()
	}
	dm, _ := numOf(deltaMode)
	return c.setScale(WheelMascotScale(c.scale, dy, dm, c.capNow()))
}

func (c *Controller) ScaleReset() ScaleState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.setScale(DefaultMascotScale)
}

func (c *Controller) ScaleState() ScaleState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.scaleState()
}

// Scale：生效缩放（建窗口时用）
func (c *Controller) Scale() float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.scale
}

// SetConfig：raw 为解析后的 JSON（map[string]any）；非布尔字段忽略
func (c *Controller) SetConfig(raw any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	m, _ := raw.(map[string]any)
	set := func(k string, dst *bool) {
		if b, ok := m[k].(bool); ok {
			*dst = b
		}
	}
	set("clickThrough", &c.cfg.ClickThrough)
	set("gravity", &c.cfg.Gravity)
	set("wander", &c.cfg.Wander)
	set("reactions", &c.cfg.Reactions)
	set("globalLook", &c.cfg.GlobalLook)
	if !c.cfg.ClickThrough {
		c.applyIgnore(false)
		if c.shapeMode() {
			c.setShape([]any{})
		}
	}
	if !c.cfg.Wander && c.body.Mode == "walking" {
		c.body.Mode = "idle"
		c.body.VX = 0
	}
	c.host.Info("看板娘互动设置", c.cfg)
}

func (c *Controller) capNow() float64 {
	wx, _ := c.win.GetPosition()
	w, _ := c.win.GetSize()
	cx := float64(wx) + float64(w)/2
	if c.box != nil {
		cx = float64(wx) + (c.box.Left+c.box.Right)/2
	}
	if len(c.workAreas) == 0 {
		return MaxScaleForArea(nil)
	}
	a := AreaUnder(c.workAreas, cx)
	return MaxScaleForArea(&a)
}

func (c *Controller) scaleState() ScaleState {
	var w, h int
	if !c.win.IsDestroyed() {
		w, h = c.win.GetSize()
	}
	return ScaleState{Scale: c.scale, Min: MinMascotScale, Max: c.capNow(), HardMax: MaxMascotScale,
		Default: DefaultMascotScale, Step: MascotScaleStep, Window: Size{Width: float64(w), Height: float64(h)}}
}

func (c *Controller) setScale(raw float64) ScaleState {
	return c.applyScale(FitMascotScale(raw, c.capNow()), true, true)
}

func (c *Controller) applyScale(target float64, userPref, notify bool) ScaleState {
	if c.win.IsDestroyed() {
		return c.scaleState()
	}
	if userPref {
		c.pref = target
	}
	if target != c.scale {
		log.Printf("[mascot] applyScale %.2f -> %.2f cap=%.2f userPref=%v areas=%+v", c.scale, target, c.capNow(), userPref, c.workAreas)
		b := c.win.GetBounds()
		from := c.scale
		nb := ResizeMascotBounds(ResizeInput{
			Bounds:    MascotBounds{X: float64(b.X), Y: float64(b.Y), Width: float64(b.Width), Height: float64(b.Height)},
			FromScale: from, ToScale: target, Box: c.box, WorkAreas: c.workAreas,
		})
		SetWindowBounds(c.win, IRect{X: int(nb.X), Y: int(nb.Y), Width: int(nb.Width), Height: int(nb.Height)}, c.platform, true)
		c.staleSize = &Size{Width: float64(b.Width), Height: float64(b.Height)}
		r := target / from
		if c.box != nil {
			k := func(v, pad, max float64) float64 { return math.Max(0, math.Min(max, pad+float64((v-pad)*r))) }
			c.box = &CharacterBox{
				Left: k(c.box.Left, MascotPad.X, nb.Width), Right: k(c.box.Right, MascotPad.X, nb.Width),
				Top: k(c.box.Top, MascotPad.Top, nb.Height), Bottom: k(c.box.Bottom, MascotPad.Top, nb.Height),
			}
		}
		if c.drag != nil {
			c.drag = &pt{c.drag.X - (nb.X - float64(b.X)), c.drag.Y - (nb.Y - float64(b.Y))}
		}
		c.body.X, c.body.Y = nb.X, nb.Y
		c.requested = &pt{nb.X, nb.Y}
		c.scale = target
		c.hitKnown = false
	}
	st := c.scaleState()
	if userPref && c.hooks != nil && c.hooks.Save != nil {
		c.hooks.Save(c.pref)
	}
	if notify {
		c.host.Publish("mascot.scaleChanged", st)
	}
	return st
}

func (c *Controller) refreshDisplays() { c.workAreas = c.host.Displays() }

func (c *Controller) env() *PhysicsEnv {
	if c.box == nil {
		return nil
	}
	return &PhysicsEnv{WorkAreas: c.workAreas, Box: *c.box, Gravity: c.cfg.Gravity}
}

func (c *Controller) setBox(raw any) {
	m, _ := raw.(map[string]any)
	wi, hi := c.win.GetSize()
	w, h := float64(wi), float64(hi)
	if m == nil {
		return
	}
	var v [4]float64
	for i, k := range []string{"left", "right", "top", "bottom"} {
		f, ok := numOf(m[k])
		if !ok {
			return
		}
		v[i] = f
	}
	if IsStaleGeometry(m["vw"], m["vh"], w, h, c.staleSize) {
		return
	}
	box := CharacterBox{
		Left: math.Max(0, math.Min(w, v[0])), Right: math.Max(0, math.Min(w, v[1])),
		Top: math.Max(0, math.Min(h, v[2])), Bottom: math.Max(0, math.Min(h, v[3])),
	}
	if box.Right-box.Left < 10 || box.Bottom-box.Top < 10 {
		return
	}
	prev := c.box
	c.box = &box
	if prev == nil {
		if env := c.env(); env != nil && ShouldFallAtStart(c.body, *env) {
			c.body.Mode = "falling"
		}
	} else if c.drag == nil {
		c.body = AnchorOnBoxChange(c.body, prev, box, c.workAreas)
	}
}

func (c *Controller) setShape(raw any) {
	if !c.shapeMode() || c.win.IsDestroyed() {
		return
	}
	w, h := c.win.GetSize()
	full := []IRect{{0, 0, w, h}}
	rects := full
	isFull := true
	if arr, ok := raw.([]any); ok && c.cfg.ClickThrough && len(arr) > 0 {
		if len(arr) > 400 {
			arr = arr[:400]
		}
		rects = []IRect{}
		for _, it := range arr {
			r, _ := it.(map[string]any)
			var v [4]float64
			ok := true
			for i, k := range []string{"x", "y", "width", "height"} {
				f, good := numOf(r[k])
				if !good {
					ok = false
					break
				}
				v[i] = f
			}
			if !ok {
				continue
			}
			x := int(math.Max(0, math.Min(float64(w), math.Floor(v[0]))))
			y := int(math.Max(0, math.Min(float64(h), math.Floor(v[1]))))
			rects = append(rects, IRect{X: x, Y: y,
				Width:  int(math.Max(1, math.Min(float64(w-x), math.Ceil(v[2])))),
				Height: int(math.Max(1, math.Min(float64(h-y), math.Ceil(v[3]))))})
		}
		isFull = false
		if len(rects) == 0 {
			rects, isFull = full, true
		}
	}
	if isFull {
		c.shapeRects = 0
	} else {
		c.shapeRects = len(rects)
	}
	c.win.SetShape(rects)
}

func (c *Controller) setHit(hit bool) {
	c.hitKnown = true
	if c.shapeMode() || c.drag != nil {
		return
	}
	c.applyIgnore(c.cfg.ClickThrough && !hit)
}

func (c *Controller) applyIgnore(ignore bool) {
	if ignore == c.ignoring || c.win.IsDestroyed() {
		return
	}
	c.ignoring = ignore
	c.win.SetIgnoreMouseEvents(ignore)
}

func (c *Controller) dragStart(p *pt) {
	c.lastActivityAt = c.host.Now()
	c.schedule(tickMS)
	var cp pt
	if p != nil {
		cp = *p
	} else {
		x, y := c.host.Cursor()
		cp = pt{x, y}
	}
	c.dragPoint = &cp
	c.appliedDrag = nil
	c.lastDragMoveAt = math.Inf(-1)
	w, h := c.win.GetSize()
	c.dragWinSize = &Size{Width: float64(w), Height: float64(h)}
	if c.platform == "win32" && !c.win.IsResizable() {
		c.win.SetResizable(true)
		c.dragUnlocked = true
	}
	xi, yi := c.win.GetPosition()
	x, y := float64(xi), float64(yi)
	c.drag = &pt{cp.X - x, cp.Y - y}
	c.applyIgnore(false)
	c.body = BodyState{X: x, Y: y, Mode: "held"}
	c.tracker.Reset(x, y, c.host.Now())
	c.send("mascot.physicsEvent", map[string]any{"type": "grab"})
}

func (c *Controller) dragEnd() {
	if c.drag == nil {
		return
	}
	if c.dragPoint != nil {
		c.updateDragPosition(*c.dragPoint, true)
	}
	c.drag = nil
	c.appliedDrag = nil
	ds := c.dragWinSize
	c.dragWinSize = nil
	if c.dragUnlocked && !c.win.IsDestroyed() {
		w, h := c.win.GetSize()
		if ds != nil && (math.Abs(float64(w)-ds.Width) > 1 || math.Abs(float64(h)-ds.Height) > 1) {
			SetWindowBounds(c.win, IRect{X: int(jsRound(c.body.X)), Y: int(jsRound(c.body.Y)), Width: int(ds.Width), Height: int(ds.Height)}, c.platform, true)
		}
		c.win.SetResizable(false)
		c.dragUnlocked = false
	}
	vx, vy := c.tracker.Release(c.host.Now())
	if c.cfg.Gravity {
		c.body.VX, c.body.VY, c.body.Mode = vx, vy, "falling"
	} else {
		c.body.VX, c.body.VY, c.body.Mode = 0, 0, "idle"
	}
	c.scheduleNextWander(c.host.Now())
	c.send("mascot.physicsEvent", map[string]any{"type": "release", "vx": vx, "vy": vy})
}

func (c *Controller) scheduleNextWander(from float64) {
	c.nextWanderAt = from + 20000 + float64(c.rnd()*40000)
}

func (c *Controller) startWander() {
	env := c.env()
	if env == nil || c.body.Mode != "idle" {
		return
	}
	t := PickWanderTarget(c.body, *env, c.rnd)
	c.body.Mode = "walking"
	c.body.WalkTargetX = &t
	c.scheduleNextWander(c.host.Now())
}

func (c *Controller) updateDragPosition(p pt, force bool) {
	if c.drag == nil {
		return
	}
	c.dragPoint = &p
	now := c.host.Now()
	if !force && c.appliedDrag != nil && c.appliedDrag.X == p.X && c.appliedDrag.Y == p.Y {
		return
	}
	next := c.body
	next.X, next.Y = p.X-c.drag.X, p.Y-c.drag.Y
	if env := c.env(); env != nil {
		next = ClampToWorld(next, *env)
	}
	c.body = next
	c.tracker.Sample(next.X, next.Y, now)
	c.body.VX, c.body.VY = c.tracker.VX, c.tracker.VY
	ap := p
	c.appliedDrag = &ap
	c.moveBodyWindow(now, c.drag == nil || math.IsInf(c.lastDragMoveAt, -1))
}

func (c *Controller) moveBodyWindow(now float64, verifySize bool) {
	if c.win.IsDestroyed() {
		return
	}
	nx, ny := jsRound(c.body.X), jsRound(c.body.Y)
	size := MascotWindowSize(c.scale)
	if c.drag != nil && c.dragWinSize != nil {
		size = *c.dragWinSize
	}
	same := c.requested != nil && c.requested.X == nx && c.requested.Y == ny
	if c.drag != nil && same {
		return
	}
	if c.drag == nil {
		wx, wy := c.win.GetPosition()
		if nx == float64(wx) && ny == float64(wy) {
			if !verifySize {
				return
			}
			w, h := c.win.GetSize()
			if math.Abs(float64(w)-size.Width) <= 1 && math.Abs(float64(h)-size.Height) <= 1 {
				return
			}
		}
	}
	MoveWindowTo(c.win, int(nx), int(ny), size, c.platform, verifySize, c.drag != nil)
	c.requested = &pt{nx, ny}
	c.lastDragMoveAt = now
	c.lastActivityAt = now
}

func (c *Controller) tick() {
	if c.win.IsDestroyed() {
		c.dispose()
		return
	}
	now := c.host.Now()
	dt := math.Min(0.1, (now-c.last)/1000)
	c.last = now
	if !c.win.IsVisible() || c.win.IsMinimized() {
		c.schedule(hiddenTickMS)
		return
	}
	c.frame++
	cx, cy := c.host.Cursor()
	env := c.env()
	events := []PhysicsEvent{}
	if c.drag != nil {
		c.lastActivityAt = now
		var p *pt
		if c.dragFromOSCursor() {
			p = &pt{cx, cy}
		} else {
			p = c.dragPoint
		}
		if p != nil {
			c.updateDragPosition(*p, false)
		}
	} else if env != nil {
		if c.cfg.Wander && c.body.Mode == "idle" && now >= c.nextWanderAt {
			c.scheduleNextWander(now)
			c.startWander()
			env = c.env()
		}
		c.acc += dt
		c.body, c.acc, events = Advance(c.body, c.acc, *env)
	}

	c.moveBodyWindow(now, c.drag == nil || math.IsInf(c.lastDragMoveAt, -1))

	ax := (c.body.VX - c.prevV.X) / math.Max(dt, 1e-3)
	ay := (c.body.VY - c.prevV.Y) / math.Max(dt, 1e-3)
	c.prevV = pt{c.body.VX, c.body.VY}
	moving := c.body.Mode != "idle" || math.Abs(c.body.VX)+math.Abs(c.body.VY) > 1
	if moving {
		c.lastActivityAt = now
	}
	if moving || c.frame%30 == 0 {
		if !finite(ax) {
			ax = 0
		}
		if !finite(ay) {
			ay = 0
		}
		c.send("mascot.body", BodyEvent{Mode: c.body.Mode, VX: c.body.VX, VY: c.body.VY, AX: ax, AY: ay, Dir: jsSign(c.body.VX)})
	}
	for _, e := range events {
		c.send("mascot.physicsEvent", e)
	}

	rx := cx - jsRound(c.body.X)
	ry := cy - jsRound(c.body.Y)
	if rx != c.lastCursor.X || ry != c.lastCursor.Y {
		c.lastActivityAt = now
		if now-c.lastCursorAt >= cursorMS || math.IsNaN(c.lastCursor.X) {
			c.lastCursorAt = now
			c.lastCursor = pt{rx, ry}
			w, h := c.win.GetSize()
			c.send("mascot.cursor", CursorEvent{X: rx, Y: ry, Inside: rx >= 0 && ry >= 0 && rx < float64(w) && ry < float64(h)})
		}
	}
	if !c.hitKnown && c.ignoring {
		c.applyIgnore(false)
	}
	busy := c.drag != nil || moving || now-c.lastActivityAt < activeHoldMS
	if busy {
		c.schedule(tickMS)
	} else {
		c.schedule(idleTickMS)
	}
}

type BodyEvent struct {
	Mode string  `json:"mode"`
	VX   float64 `json:"vx"`
	VY   float64 `json:"vy"`
	AX   float64 `json:"ax"`
	AY   float64 `json:"ay"`
	Dir  float64 `json:"dir"`
}

type CursorEvent struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Inside bool    `json:"inside"`
}

func (c *Controller) send(ch string, payload any) {
	if c.win.IsDestroyed() {
		return
	}
	c.host.Publish(ch, payload)
}

type Snapshot struct {
	Body             BodyState         `json:"body"`
	Ignoring         bool              `json:"ignoring"`
	ShapeRects       int               `json:"shapeRects"`
	ClickThroughMode string            `json:"clickThroughMode"`
	Box              *CharacterBox     `json:"box"`
	Cfg              InteractionConfig `json:"cfg"`
}

// Snapshot = mascot.debugSnapshot
func (c *Controller) Snapshot() Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	mode := "ignore"
	if c.shapeMode() {
		mode = "shape"
	}
	var box *CharacterBox
	if c.box != nil {
		b := *c.box
		box = &b
	}
	return Snapshot{Body: c.body, Ignoring: c.ignoring, ShapeRects: c.shapeRects, ClickThroughMode: mode, Box: box, Cfg: c.cfg}
}

// HandleKey = before-input-event：Ctrl/⌘ + =/+/-/0 缩放。返回 true 表示已处理（preventDefault）
func (c *Controller) HandleKey(typ, code, key string, control, meta, alt bool) bool {
	if typ != "keyDown" || alt || !(control || meta) {
		return false
	}
	action := ""
	switch {
	case code == "Equal" || code == "NumpadAdd" || code == "BracketRight" || key == "+" || key == "=":
		action = "up"
	case code == "Minus" || code == "NumpadSubtract" || code == "Slash" || key == "-" || key == "_":
		action = "down"
	case code == "Digit0" || code == "Numpad0" || key == "0":
		action = "reset"
	default:
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if action == "reset" {
		c.setScale(DefaultMascotScale)
	} else {
		d := 1
		if action == "down" {
			d = -1
		}
		c.setScale(StepMascotScale(c.scale, d, c.capNow()))
	}
	return true
}
