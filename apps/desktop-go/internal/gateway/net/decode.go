package net

import (
	"bufio"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

// undici 7 fetch（lib/web/fetch/index.js）的 accept-encoding 与响应解码，逐条对齐：
//   - 请求里没有 accept-encoding 时：https 加 `br, gzip, deflate`，否则 `gzip, deflate`；
//     带 Range 时先追加 `identity`（规范第 18 步）。
//   - 非 HEAD/CONNECT、非 null body 状态（101/204/205/304）且不跟随重定向时，
//     按 content-encoding 从后往前逐层解码：gzip/x-gzip、deflate（首字节 &0x0F==8 走 zlib，否则 raw）、
//     br、zstd（Electron 的 Node 带 zlib.zstd）；遇到不认识的编码则整体不解码。超过 5 层直接失败。
//   - 响应头原样保留（content-encoding / content-length 都不删）。
//   - 解码器用 SYNC_FLUSH 结束：截断的压缩流不报错，读到哪算哪。

const maxContentEncodings = 5

func acceptEncodingDefaults(req *http.Request) {
	h := req.Header
	if headerHas(h, "range") {
		addRaw(h, "accept-encoding", "identity")
	}
	if !headerHas(h, "accept-encoding") {
		if req.URL.Scheme == "https" {
			addRaw(h, "accept-encoding", "br, gzip, deflate")
		} else {
			addRaw(h, "accept-encoding", "gzip, deflate")
		}
	}
}

func headerHas(h http.Header, lower string) bool {
	for k := range h {
		if strings.EqualFold(k, lower) {
			return true
		}
	}
	return false
}

func addRaw(h http.Header, k, v string) {
	for kk := range h {
		if strings.EqualFold(kk, k) {
			// undici headersList.append：同名值用 ", " 合并成一行，名字保留调用方写法
			h[kk] = []string{strings.Join(append(h[kk], v), ", ")}
			return
		}
	}
	h[k] = []string{v} // 直接写 map：线上名字保持 undici 的小写
}

var nullBodyStatus = map[int]bool{101: true, 204: true, 205: true, 304: true}

// decodeResponse 按 undici 规则替换 resp.Body；返回 error = fetch 失败（太多层编码）。
func decodeResponse(method string, resp *http.Response) error {
	if method == "HEAD" || method == "CONNECT" || nullBodyStatus[resp.StatusCode] || resp.Body == nil {
		return nil
	}
	ce := strings.Join(resp.Header.Values("Content-Encoding"), ", ")
	if ce == "" {
		return nil
	}
	codings := strings.Split(strings.ToLower(ce), ",")
	if len(codings) > maxContentEncodings {
		resp.Body.Close()
		return fmt.Errorf("too many content-encodings in response: %d, maximum allowed is %d", len(codings), maxContentEncodings)
	}
	var chain []func(io.Reader) io.Reader
	for i := len(codings) - 1; i >= 0; i-- {
		switch strings.Trim(codings[i], " \t") {
		case "gzip", "x-gzip":
			chain = append(chain, gunzipReader)
		case "deflate":
			chain = append(chain, inflateReader)
		case "br":
			chain = append(chain, func(r io.Reader) io.Reader { return brotli.NewReader(r) })
		case "zstd":
			chain = append(chain, zstdReader)
		default:
			return nil
		}
	}
	var r io.Reader = resp.Body
	for _, f := range chain {
		r = lenient{f(r)}
	}
	resp.Body = &decodedBody{r: r, c: resp.Body}
	return nil
}

func gunzipReader(r io.Reader) io.Reader {
	br := bufio.NewReader(r)
	return &lazy{open: func() (io.Reader, error) {
		if _, err := br.Peek(1); err != nil {
			return eofReader{}, nil // 空体：zlib 同样不报错
		}
		return gzip.NewReader(br)
	}}
}

func inflateReader(r io.Reader) io.Reader {
	br := bufio.NewReader(r)
	return &lazy{open: func() (io.Reader, error) {
		b, err := br.Peek(1)
		if err != nil {
			return eofReader{}, nil // InflateStream：没收到字节就不建解码器
		}
		if b[0]&0x0F == 0x08 {
			return zlib.NewReader(br)
		}
		return flate.NewReader(br), nil
	}}
}

func zstdReader(r io.Reader) io.Reader {
	return &lazy{open: func() (io.Reader, error) {
		d, err := zstd.NewReader(r, zstd.WithDecoderConcurrency(1))
		if err != nil {
			return nil, err
		}
		return d.IOReadCloser(), nil
	}}
}

type eofReader struct{}

func (eofReader) Read([]byte) (int, error) { return 0, io.EOF }

type lazy struct {
	open func() (io.Reader, error)
	r    io.Reader
	err  error
}

func (l *lazy) Read(p []byte) (int, error) {
	if l.r == nil && l.err == nil {
		l.r, l.err = l.open()
	}
	if l.err != nil {
		return 0, l.err
	}
	return l.r.Read(p)
}

// lenient：SYNC_FLUSH 收尾——流被截断时当作正常结束
type lenient struct{ r io.Reader }

func (l lenient) Read(p []byte) (int, error) {
	n, err := l.r.Read(p)
	if errors.Is(err, io.ErrUnexpectedEOF) {
		err = io.EOF
	}
	return n, err
}

type decodedBody struct {
	r io.Reader
	c io.Closer
}

func (d *decodedBody) Read(p []byte) (int, error) { return d.r.Read(p) }
func (d *decodedBody) Close() error               { return d.c.Close() }
