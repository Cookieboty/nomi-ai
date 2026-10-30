package chatbg

import (
	"bytes"
	"image"
	"image/draw"
	"image/jpeg"
	"image/png"
	"math"
	"runtime"
	"sync"
)

// decodeNative = electron::util::AddImageSkiaRepFromBuffer（无宽高参数时）：先试 PNG，再试 JPEG
func decodeNative(data []byte) image.Image {
	if img, err := png.Decode(bytes.NewReader(data)); err == nil {
		return img
	}
	if img, err := jpeg.Decode(bytes.NewReader(data)); err == nil {
		return img
	}
	return nil
}

// roundF32 = gfx::ToRoundedInt(float)：四舍五入、远离零
func roundF32(v float32) int { return int(math.Round(float64(v))) }

// ResizeDims = NativeImage::Resize 只给 width 或只给 height 时的尺寸：
// 宽 ≥ 高 → {width: 2560}，高 = ToRoundedInt(2560 × (1.f / aspect))；否则 {height: 2560}，宽 = ToRoundedInt(2560 × aspect)，
// aspect = float(w)/float(h)，全程 float32（与 C++ 一致）
func ResizeDims(w, h int) (int, int) {
	aspect := float32(w) / float32(h)
	if w >= h {
		inv := float32(1) / aspect
		return MaxEdge, roundF32(float32(MaxEdge) * inv)
	}
	return roundF32(float32(MaxEdge) * aspect), MaxEdge
}

// lanczos3：quality 'best' = skia RESIZE_BEST = Lanczos3 可分离卷积（缩小时核按比例展宽），在预乘 RGBA 上计算。
// Skia 用 14 位定点系数与 SIMD，像素不可能逐字节一致；尺寸、格式与取舍规则一致（见 docs D-B10-6）。
func lanczos3(src image.Image, w, h int) image.Image {
	b := src.Bounds()
	rgba := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(rgba, rgba.Bounds(), src, b.Min, draw.Src)
	sw, sh := b.Dx(), b.Dy()
	tmp := make([]float32, w*sh*4)
	wx := weights(sw, w)
	parallelRows(sh, func(y int) {
		row := rgba.Pix[y*rgba.Stride:]
		for x := 0; x < w; x++ {
			var acc [4]float32
			for _, c := range wx[x] {
				p := row[c.i*4:]
				for k := 0; k < 4; k++ {
					acc[k] += float32(c.w * float32(p[k]))
				}
			}
			copy(tmp[(y*w+x)*4:], acc[:])
		}
	})
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	wy := weights(sh, h)
	parallelRows(h, func(y int) {
		for x := 0; x < w; x++ {
			var acc [4]float32
			for _, c := range wy[y] {
				p := tmp[(c.i*w+x)*4:]
				for k := 0; k < 4; k++ {
					acc[k] += float32(c.w * p[k])
				}
			}
			o := y*dst.Stride + x*4
			a := clamp8(acc[3])
			for k := 0; k < 3; k++ {
				v := clamp8(acc[k])
				if v > a { // 预乘约束：颜色分量不超过 alpha（skia 同样钳制）
					v = a
				}
				dst.Pix[o+k] = v
			}
			dst.Pix[o+3] = a
		}
	})
	return dst
}

type tap struct {
	i int
	w float32
}

func clamp8(v float32) uint8 {
	r := math.Round(float64(v))
	if r < 0 {
		return 0
	}
	if r > 255 {
		return 255
	}
	return uint8(r)
}

func lanczos(x float64) float64 {
	if x == 0 {
		return 1
	}
	if x <= -3 || x >= 3 {
		return 0
	}
	px := math.Pi * x
	return 3 * math.Sin(px) * math.Sin(px/3) / (px * px)
}

func weights(srcN, dstN int) [][]tap {
	scale := float64(dstN) / float64(srcN)
	support := 3.0
	clampScale := math.Min(1, scale)
	support /= clampScale
	out := make([][]tap, dstN)
	for d := 0; d < dstN; d++ {
		center := (float64(d)+0.5)/scale - 0.5
		lo, hi := int(math.Floor(center-support)), int(math.Ceil(center+support))
		var taps []tap
		var sum float64
		for i := lo; i <= hi; i++ {
			wv := lanczos((float64(i) - center) * clampScale)
			if wv == 0 {
				continue
			}
			j := min(max(i, 0), srcN-1)
			taps = append(taps, tap{j, float32(wv)})
			sum += wv
		}
		for k := range taps {
			taps[k].w = float32(float64(taps[k].w) / sum)
		}
		out[d] = taps
	}
	return out
}

// Process = importNow 里非 GIF 的那段：image.size → 长边超 MaxEdge 才 resize（PNG 存 PNG，其余存 JPEG q85 且扩展名改 .jpg）；
// 返回 nil 表示原样复制
func Process(ext string, data []byte) (out []byte, outExt string, err error) {
	img := decodeNative(data)
	if img == nil {
		return nil, ext, nil // 解不出 → 尺寸按 0×0，原样复制
	}
	b := img.Bounds()
	if max(b.Dx(), b.Dy()) <= MaxEdge {
		return nil, ext, nil
	}
	w, h := ResizeDims(b.Dx(), b.Dy())
	out = []byte{} // 缩成 0 边的空图：toPNG/toJPEG 返回空 Buffer，Node 照样写出 0 字节文件
	if w > 0 && h > 0 {
		var buf bytes.Buffer
		if ext == ".png" {
			err = png.Encode(&buf, lanczos3(img, w, h))
		} else {
			err = jpeg.Encode(&buf, lanczos3(img, w, h), &jpeg.Options{Quality: 85})
		}
		if err != nil {
			return nil, ext, err
		}
		out = buf.Bytes()
	}
	if ext != ".png" {
		ext = ".jpg"
	}
	return out, ext, nil
}

// parallelRows 把行分块给 GOMAXPROCS 个 goroutine（各行互不重叠写入，结果与串行逐位相同）
func parallelRows(n int, f func(y int)) {
	workers := min(runtime.GOMAXPROCS(0), n)
	if workers <= 1 {
		for y := 0; y < n; y++ {
			f(y)
		}
		return
	}
	var wg sync.WaitGroup
	chunk := (n + workers - 1) / workers
	for s := 0; s < n; s += chunk {
		wg.Add(1)
		go func(s, e int) {
			defer wg.Done()
			for y := s; y < e; y++ {
				f(y)
			}
		}(s, min(s+chunk, n))
	}
	wg.Wait()
}
