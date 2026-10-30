package gateway_test

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	gnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
)

type recServer struct {
	ln   net.Listener
	mu   sync.Mutex
	conn int
	saw  [][]string
}

func newRec(t *testing.T) *recServer {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	r := &recServer{ln: ln}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			r.mu.Lock()
			r.conn++
			r.mu.Unlock()
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReader(c)
				var lines []string
				for {
					l, err := br.ReadString('\n')
					if err != nil {
						return
					}
					l = strings.TrimRight(l, "\r\n")
					if l == "" {
						break
					}
					lines = append(lines, l)
				}
				r.mu.Lock()
				r.saw = append(r.saw, lines)
				r.mu.Unlock()
				c.Write([]byte("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n"))
			}(c)
		}
	}()
	return r
}

func (r *recServer) port() int { return r.ln.Addr().(*net.TCPAddr).Port }

func TestParityProxy(t *testing.T) {
	var fx struct {
		Cases []struct {
			Env      map[string]string
			Target   string
			Via      string
			ProxySaw [][]string
		}
	}
	loadFixture(t, "proxy", &fx)
	tl := tally{}
	for _, c := range fx.Cases {
		px, dx := newRec(t), newRec(t)
		pAddr := "127.0.0.1:" + strconv.Itoa(px.port())
		dPort := strconv.Itoa(dx.port())
		sub := func(s string) string {
			return strings.ReplaceAll(strings.ReplaceAll(s, "{PROXY}", pAddr), "{DIRECT}", dPort)
		}
		env := map[string]string{}
		for k, v := range c.Env {
			env[k] = sub(v)
		}
		target := sub(c.Target)
		host := "api.example.com:" + dPort
		f := gnet.CreateUpstreamFetch(gnet.FetchOptions{
			Env: func(k string) (string, bool) { v, ok := env[k]; return v, ok },
			GetGuard: func() gnet.GuardOpts {
				return gnet.GuardOpts{AllowedPrivateHosts: []string{host}, LookupAll: func(context.Context, string) ([]gnet.LookupAddress, error) {
					return []gnet.LookupAddress{{Address: "127.0.0.1", Family: 4}}, nil
				}}
			},
		})
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		req, _ := http.NewRequestWithContext(ctx, "GET", target, nil)
		if resp, err := f(req); err == nil {
			resp.Body.Close()
		}
		cancel()
		time.Sleep(20 * time.Millisecond)
		px.mu.Lock()
		dx.mu.Lock()
		via := "none"
		if px.conn > 0 {
			via = "proxy"
		} else if dx.conn > 0 {
			via = "direct"
		}
		saw := [][]string{}
		for _, ls := range px.saw {
			row := []string{}
			for _, l := range ls {
				row = append(row, strings.ReplaceAll(strings.ReplaceAll(l, pAddr, "{PROXY}"), dPort, "{DIRECT}"))
			}
			saw = append(saw, row)
		}
		px.mu.Unlock()
		dx.mu.Unlock()
		ok := via == c.Via && reflect.DeepEqual(saw, c.ProxySaw)
		if !ok {
			t.Errorf("proxy env=%v target=%s: via=%s saw=%q want via=%s saw=%q", c.Env, c.Target, via, saw, c.Via, c.ProxySaw)
		}
		tl.add("proxy", ok)
		px.ln.Close()
		dx.ln.Close()
	}
	tl.report(t, "proxy")
}
