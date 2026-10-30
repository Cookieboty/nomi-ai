// Package mascot 对应 apps/desktop-electron/internal/core/src/mascot（mascotSize.ts）：桌面角色窗口大小的纯函数，逐行照抄。
package mascot

import "math"

type Size struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

var (
	MascotBase = Size{Width: 420, Height: 450}
	MascotPad  = struct{ X, Top float64 }{X: 60, Top: 130}
)

const (
	DefaultMascotScale = 0.5
	MinMascotScale     = 0.3
	MaxMascotScale     = 1.5
	MascotScaleStep    = 0.1
	MascotFitSlack     = 4
)

// jsRound = Math.round（.5 向 +∞）
func jsRound(v float64) float64 { return math.Floor(float64(v) + 0.5) }

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// ClampMascotScale：v 为 nil / 非数字时取默认
func ClampMascotScale(v any) float64 {
	n := DefaultMascotScale
	if f, ok := v.(float64); ok && finite(f) {
		n = f
	}
	return math.Min(MaxMascotScale, math.Max(MinMascotScale, n))
}

func RoundMascotScale(v float64) float64 { return jsRound(v*100) / 100 }

type AreaRect struct {
	X           float64  `json:"x"`
	Y           float64  `json:"y"`
	Width       float64  `json:"width"`
	Height      float64  `json:"height"`
	ScaleFactor *float64 `json:"scaleFactor,omitempty"`
}

func PhysicalBottom(top, height, scaleFactor float64) float64 {
	sf := scaleFactor
	if !(finite(sf) && sf > 0) {
		sf = 1
	}
	if sf == 1 {
		return top + height
	}
	const eps = 1e-9
	pb := math.Ceil(float64((top+height)*sf) - eps)
	return math.Ceil(pb/sf - eps)
}

func MaxTopInArea(area AreaRect, height float64) float64 {
	bottom := area.Y + area.Height
	y := math.Floor(bottom - height)
	sf := 1.0
	if area.ScaleFactor != nil {
		sf = *area.ScaleFactor
	}
	for i := 0; i < 4 && y > area.Y; i++ {
		if area.Y+PhysicalBottom(y-area.Y, height, sf) <= bottom {
			break
		}
		y--
	}
	return y
}

// MaxScaleForArea：area 为 nil 等价于 null/undefined
func MaxScaleForArea(area *AreaRect) float64 {
	if area == nil || !(area.Width > 0) || !(area.Height > 0) {
		return MaxMascotScale
	}
	byHeight := (area.Height - MascotPad.Top - MascotFitSlack) / MascotBase.Height
	byWidth := (area.Width * 0.5) / MascotBase.Width
	c := math.Floor(math.Min(byHeight, byWidth)*100) / 100
	return math.Min(MaxMascotScale, math.Max(MinMascotScale, c))
}

func FitMascotScale(v any, cap float64) float64 {
	hi := math.Min(MaxMascotScale, math.Max(MinMascotScale, cap))
	return RoundMascotScale(math.Min(hi, ClampMascotScale(v)))
}

func StepMascotScale(current float64, dir int, cap float64) float64 {
	k := ClampMascotScale(current) / MascotScaleStep
	var grid float64
	if dir == 1 {
		grid = math.Floor(k+1e-6) + 1
	} else {
		grid = math.Ceil(k-1e-6) - 1
	}
	return FitMascotScale(grid*MascotScaleStep, cap)
}

func WheelMascotScale(current, deltaY, deltaMode, cap float64) float64 {
	if !finite(deltaY) || deltaY == 0 {
		return FitMascotScale(current, cap)
	}
	px := deltaY
	if deltaMode == 1 {
		px = deltaY * 16
	} else if deltaMode == 2 {
		px = deltaY * 100
	}
	d := math.Max(-300, math.Min(300, px))
	return FitMascotScale(ClampMascotScale(current)*math.Exp(-d*0.002), cap)
}

func MascotWindowSize(scale float64) Size {
	s := ClampMascotScale(scale)
	return Size{
		Width:  jsRound(float64(MascotBase.Width*s) + float64(2*MascotPad.X)),
		Height: jsRound(float64(MascotBase.Height*s) + MascotPad.Top),
	}
}

type MascotBounds struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type MascotBox struct {
	Left   float64 `json:"left"`
	Right  float64 `json:"right"`
	Top    float64 `json:"top"`
	Bottom float64 `json:"bottom"`
}

type ResizeInput struct {
	Bounds    MascotBounds `json:"bounds"`
	FromScale float64      `json:"fromScale"`
	ToScale   float64      `json:"toScale"`
	Box       *MascotBox   `json:"box,omitempty"`
	WorkAreas []AreaRect   `json:"workAreas,omitempty"`
}

func ResizeMascotBounds(in ResizeInput) MascotBounds {
	b := in.Bounds
	next := MascotWindowSize(in.ToScale)
	from := ClampMascotScale(in.FromScale)
	to := ClampMascotScale(in.ToScale)
	ratio := to / from
	mapX := func(v float64) float64 { return MascotPad.X + float64((v-MascotPad.X)*ratio) }
	mapY := func(v float64) float64 { return MascotPad.Top + float64((v-MascotPad.Top)*ratio) }
	box := in.Box
	okBox := box != nil && finite(box.Left) && finite(box.Right) && finite(box.Top) && finite(box.Bottom)
	fx, fy := b.Width/2, b.Height
	if okBox {
		fx, fy = (box.Left+box.Right)/2, box.Bottom
	}
	x := jsRound(b.X + fx - mapX(fx))
	y := jsRound(b.Y + fy - mapY(fy))

	if len(in.WorkAreas) > 0 {
		ax := b.X + fx
		var inside []AreaRect
		for _, a := range in.WorkAreas {
			if ax >= a.X && ax < a.X+a.Width {
				inside = append(inside, a)
			}
		}
		dist := func(a AreaRect) float64 {
			if ax < a.X {
				return a.X - ax
			}
			return ax - (a.X + a.Width)
		}
		pool := in.WorkAreas
		if len(inside) > 0 {
			pool = inside
		}
		area := pool[0]
		for _, c := range pool[1:] {
			if dist(c) < dist(area) {
				area = c
			}
		}
		visLeft, visRight := MascotPad.X, next.Width-MascotPad.X
		if okBox {
			visLeft, visRight = mapX(box.Left), mapX(box.Right)
		}
		lo := area.X - visLeft
		hi := area.X + area.Width - visRight
		if hi >= lo {
			x = math.Min(hi, math.Max(lo, x))
		} else {
			x = lo
		}
		yHi := MaxTopInArea(area, next.Height)
		if yHi >= area.Y {
			y = math.Min(yHi, math.Max(area.Y, y))
		} else {
			y = area.Y
		}
	}
	return MascotBounds{X: x, Y: y, Width: next.Width, Height: next.Height}
}

// ScaleState = types MascotScaleState
type ScaleState struct {
	Scale   float64 `json:"scale"`
	Min     float64 `json:"min"`
	Max     float64 `json:"max"`
	HardMax float64 `json:"hardMax"`
	Default float64 `json:"default"`
	Step    float64 `json:"step"`
	Window  Size    `json:"window"`
}
