package net

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// undici：https 默认 `br, gzip, deflate`（http 那一支由 TestEncodingParity 覆盖）
func TestAcceptEncodingHTTPS(t *testing.T) {
	r := &http.Request{URL: &url.URL{Scheme: "https", Host: "x"}, Header: http.Header{}}
	acceptEncodingDefaults(r)
	if got := r.Header["accept-encoding"]; len(got) != 1 || got[0] != "br, gzip, deflate" {
		t.Fatalf("%q", got)
	}
}

// Electron 的 Node 带 zlib.zstd → undici hasZstd，zstd 解码（本机录制用的 Node 22.14 没有 zstd，单测补上）
func TestZstdDecode(t *testing.T) {
	enc, _ := zstd.NewWriter(nil)
	z := enc.EncodeAll([]byte("hello zstd"), nil)
	resp := &http.Response{StatusCode: 200, Header: http.Header{"Content-Encoding": {"zstd"}}, Body: io.NopCloser(bytes.NewReader(z))}
	if err := decodeResponse("GET", resp); err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil || string(b) != "hello zstd" {
		t.Fatalf("%q %v", b, err)
	}
}
