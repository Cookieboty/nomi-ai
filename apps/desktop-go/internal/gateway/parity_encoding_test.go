package gateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	gonet "net"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	gnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
)

type encCase struct {
	Name       string            `json:"name"`
	Ce         *string           `json:"ce"`
	Body       string            `json:"body"`
	Status     int               `json:"status"`
	Location   string            `json:"location"`
	Method     string            `json:"method"`
	ReqHeaders map[string]string `json:"reqHeaders"`
	ReqBody    string            `json:"reqBody"`
	Res        *struct {
		Status          int     `json:"status"`
		ContentEncoding *string `json:"contentEncoding"`
		ContentLength   *string `json:"contentLength"`
		Body            string  `json:"body"`
	} `json:"res"`
	Error     *bool    `json:"error"`
	BodyError *bool    `json:"bodyError"`
	Seen      []string `json:"seen"`
}

var seenLine = regexp.MustCompile(`(?i)^(accept-encoding|range):`)

// TestEncodingParity：accept-encoding 与 undici 解码规则（scripts/parity/encoding.mjs）
func TestEncodingParity(t *testing.T) {
	raw, err := os.ReadFile("testdata/parity/encoding.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Bodies map[string]string `json:"bodies"`
		Cases  []encCase         `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	pass, fail := 0, 0
	for _, c := range fx.Cases {
		body, _ := base64.StdEncoding.DecodeString(fx.Bodies[c.Body])
		ln, _ := gonet.Listen("tcp", "127.0.0.1:0")
		seen := make(chan []string, 1)
		go func() {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			defer conn.Close()
			br := bufio.NewReader(conn)
			var got []string
			first := true
			for {
				l, err := br.ReadString('\n')
				l = strings.TrimRight(l, "\r\n")
				if err != nil || l == "" {
					break
				}
				if !first && seenLine.MatchString(l) {
					got = append(got, l)
				}
				first = false
			}
			seen <- got
			status := c.Status
			if status == 0 {
				status = 200
			}
			out := body
			if status == 204 || status == 304 || c.Method == "HEAD" {
				out = nil
			}
			head := []string{"HTTP/1.1 " + strconv.Itoa(status) + " X", "content-type: application/json"}
			if c.Ce != nil {
				head = append(head, "content-encoding: "+*c.Ce)
			}
			if c.Location != "" {
				head = append(head, "location: "+c.Location)
			}
			if status != 204 && status != 304 {
				head = append(head, "content-length: "+strconv.Itoa(len(body)))
			}
			head = append(head, "connection: close")
			conn.Write(append([]byte(strings.Join(head, "\r\n")+"\r\n\r\n"), out...))
		}()
		host := ln.Addr().String()
		f := gnet.CreateUpstreamFetch(gnet.FetchOptions{
			Env:      func(string) (string, bool) { return "", false },
			GetGuard: func() gnet.GuardOpts { return gnet.GuardOpts{AllowedPrivateHosts: []string{host}} },
		})
		m := c.Method
		if m == "" {
			m = "GET"
		}
		var rd io.Reader
		if c.ReqBody != "" {
			rd = strings.NewReader(c.ReqBody)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		req, _ := http.NewRequestWithContext(ctx, m, "http://"+host+"/v1", rd)
		for k, v := range c.ReqHeaders {
			req.Header[k] = []string{v}
		}
		resp, ferr := f(req)
		var got []string
		select {
		case got = <-seen:
		case <-time.After(2 * time.Second):
		}
		ok := true
		why := ""
		g, w := append([]string{}, got...), append([]string{}, c.Seen...)
		sort.Strings(g)
		sort.Strings(w)
		if strings.Join(g, "|") != strings.Join(w, "|") {
			ok, why = false, "seen "+strings.Join(got, "|")+" want "+strings.Join(c.Seen, "|")
		}
		if c.Error != nil && *c.Error {
			if ferr == nil {
				ok, why = false, "want fetch error"
			}
		} else if ferr != nil {
			ok, why = false, "fetch error "+ferr.Error()
		} else {
			b, berr := io.ReadAll(resp.Body)
			resp.Body.Close()
			wantBodyErr := c.BodyError != nil && *c.BodyError
			if wantBodyErr != (berr != nil) {
				ok, why = false, "bodyErr mismatch: "+strconv.Quote(errString(berr))
			}
			r := c.Res
			if resp.StatusCode != r.Status || hv(resp.Header, "Content-Encoding") != sp(r.ContentEncoding) || hv(resp.Header, "Content-Length") != sp(r.ContentLength) {
				ok, why = false, "status/headers "+strconv.Itoa(resp.StatusCode)+" "+hv(resp.Header, "Content-Encoding")+" "+hv(resp.Header, "Content-Length")
			}
			if !wantBodyErr {
				wb, _ := base64.StdEncoding.DecodeString(r.Body)
				if !bytes.Equal(b, wb) {
					ok, why = false, "body "+strconv.Quote(string(b))
				}
			}
		}
		cancel()
		ln.Close()
		if ok {
			pass++
		} else {
			fail++
			t.Errorf("encoding %q: %s", c.Name, why)
		}
	}
	t.Logf("encoding parity: pass=%d fail=%d", pass, fail)
}

func errString(e error) string {
	if e == nil {
		return ""
	}
	return e.Error()
}

func hv(h http.Header, k string) string {
	if v, ok := h[k]; ok {
		return strings.Join(v, ", ")
	}
	return "<nil>"
}

func sp(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}
