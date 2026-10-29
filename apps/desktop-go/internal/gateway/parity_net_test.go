package gateway_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	gerr "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/errors"
	gnet "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/net"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

func TestParityNet(t *testing.T) {
	var fx struct {
		Hosts []struct {
			Host    string
			Private bool
			V4, V6  []int
			Fake    bool
		}
		Headers []struct {
			Header string
			Port   int
			OK     bool `json:"ok"`
		}
		Guard []struct {
			URL  string `json:"url"`
			Opts struct {
				AllowedPrivateHosts []string
				SelfPort            int
			}
			Lookup    [][]any
			Addresses [][]any
			Error     string
		}
		Errors []struct {
			Wire, Kind, Message string
			Status              int
			Body                json.RawMessage
		}
		Statuses []struct {
			Status  int
			Message string
			Client  int
			Kind    string
		}
		Upstream []struct{ Text, Message string }
	}
	loadFixture(t, "net", &fx)
	tl := tally{}
	for _, c := range fx.Hosts {
		ok := gnet.IsPrivateHost(c.Host) == c.Private && reflect.DeepEqual(gnet.ParseIPv4(c.Host), c.V4) &&
			reflect.DeepEqual(gnet.ParseIPv6(c.Host), c.V6) && gnet.IsFakeIp(c.Host) == c.Fake
		if !ok {
			t.Errorf("host %q: private=%v v4=%v v6=%v want %+v", c.Host, gnet.IsPrivateHost(c.Host), gnet.ParseIPv4(c.Host), gnet.ParseIPv6(c.Host), c)
		}
		tl.add("hosts", ok)
	}
	for _, c := range fx.Headers {
		ok := gnet.IsAllowedHostHeader(c.Header, c.Port) == c.OK
		if !ok {
			t.Errorf("header %q:%d want %v", c.Header, c.Port, c.OK)
		}
		tl.add("headers", ok)
	}
	for _, c := range fx.Guard {
		look := c.Lookup
		if look == nil {
			look = [][]any{{"93.184.216.34", float64(4)}}
		}
		o := gnet.GuardOpts{AllowedPrivateHosts: c.Opts.AllowedPrivateHosts, SelfPort: c.Opts.SelfPort,
			LookupAll: func(context.Context, string) ([]gnet.LookupAddress, error) {
				out := []gnet.LookupAddress{}
				for _, a := range look {
					out = append(out, gnet.LookupAddress{Address: a[0].(string), Family: int(a[1].(float64))})
				}
				return out, nil
			}}
		_, addrs, err := gnet.ResolveUpstreamAddresses(context.Background(), c.URL, o)
		var ok bool
		if c.Error != "" {
			ok = err != nil && err.Error() == c.Error
		} else if err == nil {
			got := [][]any{}
			for _, a := range addrs {
				got = append(got, []any{a.Address, float64(a.Family)})
			}
			ok = reflect.DeepEqual(got, c.Addresses)
		}
		if !ok {
			t.Errorf("guard %s: got %v %v want %v %q", c.URL, addrs, err, c.Addresses, c.Error)
		}
		tl.add("guard", ok)
	}
	for _, c := range fx.Errors {
		st, body := gerr.ErrorResponse(c.Wire, c.Kind, c.Message)
		want, _ := u.ParseString(string(c.Body))
		ok := st == c.Status && u.Stringify(body) == u.Stringify(want)
		if !ok {
			t.Errorf("error %s/%s: %d %s want %d %s", c.Wire, c.Kind, st, u.Stringify(body), c.Status, c.Body)
		}
		tl.add("errors", ok)
	}
	for _, c := range fx.Statuses {
		ok := gerr.ClientStatusOf(c.Status) == c.Client && gerr.KindOfStatus(c.Status, c.Message) == c.Kind
		if !ok {
			t.Errorf("status %d", c.Status)
		}
		tl.add("statuses", ok)
	}
	for _, c := range fx.Upstream {
		ok := gerr.UpstreamMessage(c.Text) == c.Message
		if !ok {
			t.Errorf("upstreamMessage %q", c.Text)
		}
		tl.add("upstream", ok)
	}
	tl.report(t, "net")
}
