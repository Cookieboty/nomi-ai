package mascot

// 回放 scripts/parity/record-mascot-physics.mjs 录下的 Node 轨迹（desktopPhysics + MascotWindowController），
// 浮点逐位相同（jsHypot / jsExp 对齐 V8）。

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"reflect"
	"sort"
	"testing"
)

func mulberry32(seed uint32) func() float64 {
	a := seed
	return func() float64 {
		a += 0x6d2b79f5
		t := a
		t = (t ^ (t >> 15)) * (t | 1)
		t ^= t + (t^(t>>7))*(t|61)
		return float64(t^(t>>14)) / 4294967296
	}
}

// norm：Go 值 → JSON → any，便于与录制值比较
func norm(t *testing.T, v any) any {
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func diff(path string, want, got any) string {
	switch w := want.(type) {
	case float64:
		g, ok := got.(float64)
		if !ok || !(g == w || (math.IsNaN(g) && math.IsNaN(w))) {
			return fmt.Sprintf("%s: want %v got %v", path, want, got)
		}
		return ""
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return fmt.Sprintf("%s: want object got %v", path, got)
		}
		keys := map[string]bool{}
		for k := range w {
			keys[k] = true
		}
		for k := range g {
			keys[k] = true
		}
		ks := make([]string, 0, len(keys))
		for k := range keys {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		for _, k := range ks {
			if d := diff(path+"."+k, w[k], g[k]); d != "" {
				return d
			}
		}
		return ""
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return fmt.Sprintf("%s: want %v got %v", path, want, got)
		}
		for i := range w {
			if d := diff(fmt.Sprintf("%s[%d]", path, i), w[i], g[i]); d != "" {
				return d
			}
		}
		return ""
	}
	if !reflect.DeepEqual(want, got) {
		return fmt.Sprintf("%s: want %#v got %#v", path, want, got)
	}
	return ""
}

func remarshal(t *testing.T, src any, dst any) {
	b, _ := json.Marshal(src)
	if err := json.Unmarshal(b, dst); err != nil {
		t.Fatal(err)
	}
}

type fixtureFile struct {
	Physics    map[string]json.RawMessage `json:"physics"`
	Controller map[string][]struct {
		Name  string    `json:"name"`
		World int       `json:"world"`
		Win   []float64 `json:"win"`
		Out   []struct {
			Step []any `json:"step"`
			Now  float64
			Ret  any
			Log  []any
			Snap any
			Pos  []any
		} `json:"out"`
	} `json:"controller"`
	Worlds [][]Rect `json:"worlds"`
}

func loadFixture(t *testing.T) fixtureFile {
	raw, err := os.ReadFile("testdata/physics.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixtureFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

type envJS struct {
	WorkAreas []Rect       `json:"workAreas"`
	Box       CharacterBox `json:"box"`
	Gravity   bool         `json:"gravity"`
}

func (e envJS) env() PhysicsEnv {
	return PhysicsEnv{WorkAreas: e.WorkAreas, Box: e.Box, Gravity: e.Gravity}
}

type caseJS struct {
	In  []json.RawMessage `json:"in"`
	Out any               `json:"out"`
}

func TestPhysicsParity(t *testing.T) {
	f := loadFixture(t)
	get := func(k string) []caseJS {
		var cs []caseJS
		if err := json.Unmarshal(f.Physics[k], &cs); err != nil {
			t.Fatal(k, err)
		}
		if len(cs) == 0 {
			t.Fatal("empty", k)
		}
		return cs
	}
	u := func(r json.RawMessage, v any) {
		if err := json.Unmarshal(r, v); err != nil {
			t.Fatal(err)
		}
	}
	check := func(name string, i int, want, got any) {
		t.Helper()
		if d := diff(fmt.Sprintf("%s[%d]", name, i), want, norm(t, got)); d != "" {
			t.Fatal(d)
		}
	}
	for i, c := range get("step") {
		var s BodyState
		var dt float64
		var e envJS
		u(c.In[0], &s)
		u(c.In[1], &dt)
		u(c.In[2], &e)
		st, ev := Step(s, dt, e.env())
		if ev == nil {
			ev = []PhysicsEvent{}
		}
		check("step", i, c.Out, map[string]any{"state": st, "events": ev})
	}
	for i, c := range get("advance") {
		var s BodyState
		var acc float64
		var e envJS
		u(c.In[0], &s)
		u(c.In[1], &acc)
		u(c.In[2], &e)
		st, a, ev := Advance(s, acc, e.env())
		if ev == nil {
			ev = []PhysicsEvent{}
		}
		check("advance", i, c.Out, map[string]any{"state": st, "accumulator": a, "events": ev})
	}
	for i, c := range get("clamp") {
		var s BodyState
		var e envJS
		u(c.In[0], &s)
		u(c.In[1], &e)
		check("clamp", i, c.Out, ClampToWorld(s, e.env()))
	}
	for i, c := range get("fallAtStart") {
		var s BodyState
		var e envJS
		u(c.In[0], &s)
		u(c.In[1], &e)
		check("fallAtStart", i, c.Out, ShouldFallAtStart(s, e.env()))
	}
	for i, c := range get("wander") {
		var s BodyState
		var e envJS
		var seed uint32
		u(c.In[0], &s)
		u(c.In[1], &e)
		u(c.In[2], &seed)
		check("wander", i, c.Out, PickWanderTarget(s, e.env(), mulberry32(seed)))
	}
	for i, c := range get("anchor") {
		var s BodyState
		var p, n CharacterBox
		var areas []Rect
		u(c.In[0], &s)
		u(c.In[1], &p)
		u(c.In[2], &n)
		u(c.In[3], &areas)
		check("anchor", i, c.Out, AnchorOnBoxChange(s, &p, n, areas))
	}
	for i, c := range get("areaUnder") {
		var areas []Rect
		var cx float64
		u(c.In[0], &areas)
		u(c.In[1], &cx)
		check("areaUnder", i, c.Out, AreaUnder(areas, cx))
	}
	var tr [][][]any
	u(f.Physics["tracker"], &tr)
	for i, ops := range tr {
		v := NewVelocityTracker()
		for j, op := range ops {
			n := func(k int) float64 { return op[k].(float64) }
			var got []any
			switch op[0] {
			case "reset":
				v.Reset(n(1), n(2), n(3))
				got = op
			case "sample":
				v.Sample(n(1), n(2), n(3))
				got = []any{"sample", n(1), n(2), n(3), v.VX, v.VY}
			case "release":
				vx, vy := v.Release(n(1))
				got = []any{"release", n(1), vx, vy}
			}
			check(fmt.Sprintf("tracker[%d]", i), j, op, got)
		}
	}
}

// —— 控制器回放

type fakeTimer struct {
	id  int
	due float64
	fn  func()
}

type fakeWorld struct {
	now      float64
	timers   []*fakeTimer
	tid      int
	cursor   [2]float64
	displays []Rect
	log      []any
	// window
	x, y, w, h                               int
	resizable, visible, minimized, destroyed bool
}

func (f *fakeWorld) IsDestroyed() bool       { return f.destroyed }
func (f *fakeWorld) GetPosition() (int, int) { return f.x, f.y }
func (f *fakeWorld) GetSize() (int, int)     { return f.w, f.h }
func (f *fakeWorld) GetBounds() IRect        { return IRect{f.x, f.y, f.w, f.h} }
func (f *fakeWorld) IsResizable() bool       { return f.resizable }
func (f *fakeWorld) IsVisible() bool         { return f.visible }
func (f *fakeWorld) IsMinimized() bool       { return f.minimized }
func (f *fakeWorld) SetIgnoreMouseEvents(b bool) {
	f.log = append(f.log, []any{"setIgnoreMouseEvents", b})
}
func (f *fakeWorld) SetShape(r []IRect) { f.log = append(f.log, []any{"setShape", r}) }
func (f *fakeWorld) SetResizable(b bool) {
	f.log = append(f.log, []any{"setResizable", b})
	f.resizable = b
}
func (f *fakeWorld) SetBounds(r IRect) {
	f.log = append(f.log, []any{"setBounds", r.X, r.Y, r.Width, r.Height})
	f.x, f.y, f.w, f.h = r.X, r.Y, r.Width, r.Height
}
func (f *fakeWorld) SetPosition(x, y int) {
	f.log = append(f.log, []any{"setPosition", x, y})
	f.x, f.y = x, y
}
func (f *fakeWorld) Now() float64 { return f.now }
func (f *fakeWorld) After(ms float64, fn func()) func() {
	f.tid++
	t := &fakeTimer{id: f.tid, due: f.now + ms, fn: fn}
	f.timers = append(f.timers, t)
	return func() {
		for i, x := range f.timers {
			if x == t {
				f.timers = append(f.timers[:i], f.timers[i+1:]...)
				return
			}
		}
	}
}
func (f *fakeWorld) Cursor() (float64, float64) { return f.cursor[0], f.cursor[1] }
func (f *fakeWorld) Displays() []Rect {
	out := make([]Rect, len(f.displays))
	for i, d := range f.displays {
		out[i] = d
		if d.ScaleFactor == nil {
			one := 1.0
			out[i].ScaleFactor = &one
		}
	}
	return out
}
func (f *fakeWorld) Publish(ch string, p any) { f.log = append(f.log, []any{"publish", ch, p}) }
func (f *fakeWorld) Info(string, any)         {}
func (f *fakeWorld) Warn(string, any)         {}

func (f *fakeWorld) run(ms float64) {
	end := f.now + ms
	for {
		sort.SliceStable(f.timers, func(i, j int) bool {
			if f.timers[i].due != f.timers[j].due {
				return f.timers[i].due < f.timers[j].due
			}
			return f.timers[i].id < f.timers[j].id
		})
		if len(f.timers) == 0 || f.timers[0].due > end {
			break
		}
		t := f.timers[0]
		f.timers = f.timers[1:]
		f.now = t.due
		t.fn()
	}
	f.now = end
}

func TestControllerParity(t *testing.T) {
	f := loadFixture(t)
	for _, platform := range []string{"darwin", "linux", "win32"} {
		for _, sc := range f.Controller[platform] {
			t.Run(platform+"/"+sc.Name, func(t *testing.T) {
				sz := MascotWindowSize(sc.Win[2])
				w := &fakeWorld{now: 1000, displays: f.Worlds[sc.World], x: int(sc.Win[0]), y: int(sc.Win[1]),
					w: int(sz.Width), h: int(sz.Height), visible: true}
				var logSave []any
				ctl := NewController(w, w, mulberry32(7), &ScaleHooks{
					Get:  func() float64 { return sc.Win[2] },
					Save: func(v float64) { w.log = append(w.log, []any{"save", v}) },
				}, platform)
				_ = logSave
				for i, o := range sc.Out {
					w.log = nil
					s := o.Step
					n := func(k int) float64 { return s[k].(float64) }
					var ret any
					switch s[0] {
					case "start":
						ctl.Start()
					case "run":
						w.run(n(1))
					case "config":
						ctl.SetConfig(s[1])
					case "geometry":
						ctl.ReportGeometry(s[1])
					case "cursor":
						w.cursor = [2]float64{n(1), n(2)}
					case "hit":
						ctl.ReportHit(s[1])
					case "shape":
						ctl.ReportShape(s[1])
					case "beginDrag":
						ctl.BeginDrag(s[1], s[2])
					case "moveDrag":
						ctl.MoveDrag(s[1], s[2])
					case "endDrag":
						ctl.EndDrag()
					case "wanderNow":
						ctl.WanderNow()
					case "scaleStep":
						ret = ctl.ScaleStep(s[1])
					case "scaleSet":
						ret = ctl.ScaleSet(s[1])
					case "scaleWheel":
						ret = ctl.ScaleWheel(s[1], s[2])
					case "scaleReset":
						ret = ctl.ScaleReset()
					case "key":
						ret = ctl.HandleKey(s[1].(string), s[2].(string), s[3].(string), s[4].(bool), s[5].(bool), s[6].(bool))
					case "displays":
						remarshal(t, s[1], &w.displays)
						ctl.DisplaysChanged()
					case "visible":
						w.visible = s[1].(bool)
					case "wake":
						ctl.Wake()
					case "destroy":
						w.destroyed = true
						ctl.Dispose()
					}
					if w.log == nil {
						w.log = []any{}
					}
					got := map[string]any{"step": s, "now": w.now, "ret": ret, "log": w.log, "snap": ctl.Snapshot(),
						"pos": []int{w.x, w.y, w.w, w.h}}
					want := map[string]any{"step": o.Step, "now": o.Now, "ret": o.Ret, "log": o.Log, "snap": o.Snap, "pos": o.Pos}
					if d := diff(fmt.Sprintf("step[%d]%v", i, s[0]), norm(t, want), norm(t, got)); d != "" {
						t.Fatal(d)
					}
				}
			})
		}
	}
}
