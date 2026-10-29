package chatbg

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"testing"
)

// Electron nativeImage 录制（scripts/parity/record-chatbg-image.cjs）：解码集、是否缩放、输出格式、输出尺寸、扩展名。
// 像素不比（Skia 定点 Lanczos3 + 自带编码器），见 docs D-B10-6。
type imgCase struct {
	Enc     string                       `json:"enc"`
	W       int                          `json:"w"`
	H       int                          `json:"h"`
	Fixed   string                       `json:"fixed"`
	Ext     string                       `json:"ext"`
	OutExt  string                       `json:"outExt"`
	Resized bool                         `json:"resized"`
	Format  *string                      `json:"format"`
	Out     *struct{ Width, Height int } `json:"out"`
}

func genImage(t *testing.T, enc string, w, h int) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < w*h; i++ {
		copy(img.Pix[i*4:], []uint8{uint8(i % 251), uint8((i >> 3) % 253), 128, 255})
	}
	var b bytes.Buffer
	var err error
	if enc == "png" {
		err = png.Encode(&b, img)
	} else {
		err = jpeg.Encode(&b, img, &jpeg.Options{Quality: 90})
	}
	if err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func magic(b []byte) string {
	switch {
	case len(b) == 0:
		return "empty"
	case b[0] == 0x89:
		return "png"
	case b[0] == 0xff:
		return "jpeg"
	}
	return "other"
}

func TestImageParity(t *testing.T) {
	// -race 下大图编解码慢 10 倍以上（CI 600s 超时）；CI 另有一步不带 -race 专门跑本测试（desktop-go.yml "chatbg image parity"），不算跳过
	if raceOn {
		t.Skip("runs without -race in the dedicated CI step")
	}
	raw, err := os.ReadFile("testdata/image.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Fixed map[string]string `json:"fixed"`
		Cases []imgCase         `json:"cases"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	cache := map[string][]byte{}
	memo := map[string][]byte{} // .jpg/.jpeg/.webp 走同一分支、输出相同，只算一次
	for _, c := range g.Cases {
		var data []byte
		if c.Fixed != "" {
			data, _ = base64.StdEncoding.DecodeString(g.Fixed[c.Fixed])
		} else {
			k := fmt.Sprint(c.Enc, c.W, "x", c.H)
			if cache[k] == nil {
				cache[k] = genImage(t, c.Enc, c.W, c.H)
			}
			data = cache[k]
		}
		var out []byte
		var ext string
		var err error
		if c.Fixed == "" && c.Ext != ".png" {
			mk := fmt.Sprint(c.Enc, c.W, "x", c.H, "jpg")
			if r, ok := memo[mk]; ok && r != nil {
				out, ext = r, ".jpg"
			} else if out, ext, err = Process(c.Ext, data); err == nil && out != nil {
				memo[mk] = out
			}
		} else {
			out, ext, err = Process(c.Ext, data)
		}
		if err != nil {
			t.Fatalf("%+v: %v", c, err)
		}
		if ext != c.OutExt || (out != nil) != c.Resized {
			t.Errorf("%+v: got ext=%s resized=%v", c, ext, out != nil)
			continue
		}
		if c.Format != nil && magic(out) != *c.Format {
			t.Errorf("%+v: format %s want %s", c, magic(out), *c.Format)
		}
		if c.Out != nil {
			cfg, _, err := image.DecodeConfig(bytes.NewReader(out))
			if err != nil || cfg.Width != c.Out.Width || cfg.Height != c.Out.Height {
				t.Errorf("%+v: out %dx%d err=%v", c, cfg.Width, cfg.Height, err)
			}
		}
	}
	t.Logf("%d cases", len(g.Cases))
}
