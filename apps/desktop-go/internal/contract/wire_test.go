package contract

import "testing"

func TestEncodeWireEventNullData(t *testing.T) {
	for _, c := range []struct {
		f    ServerFrame
		want string
	}{
		{ServerFrame{T: "event", Event: "gateway.changed"}, `{"t":"event","event":"gateway.changed","data":null}`},
		{ServerFrame{T: "event", Event: "x", Data: 1}, `{"t":"event","data":1,"event":"x"}`},
		{ServerFrame{T: "res", ID: "1"}, `{"t":"res","id":"1"}`},
	} {
		b, err := EncodeWire(c.f)
		if err != nil || string(b) != c.want {
			t.Fatalf("got %s %v, want %s", b, err, c.want)
		}
	}
}
