package jsrt

import (
	"errors"
	"testing"
)

// async 函数同步段立即执行；首个 await 处把控制权交回调用者。
func TestAsyncOrder(t *testing.T) {
	var log []string
	Run(func() {
		gate := NewPromise[int]()
		p := Async(func() (int, error) {
			log = append(log, "a1")
			v, _ := Await(gate)
			log = append(log, "a2")
			return v + 1, nil
		})
		log = append(log, "caller")
		q := Async(func() (int, error) { log = append(log, "b"); return 0, errors.New("x") })
		gate.Resolve(41)
		v, _ := Await(p)
		_, err := Await(q)
		if v != 42 || err == nil {
			t.Fatal(v, err)
		}
	})
	want := "a1,caller,b,a2"
	got := ""
	for i, s := range log {
		if i > 0 {
			got += ","
		}
		got += s
	}
	if got != want {
		t.Fatal(got)
	}
}
