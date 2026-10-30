package contract

import (
	"encoding/base64"
	"encoding/json"
)

// Bytes 在线上编成 {"$u8":"<base64>"}（wire.ts）
type Bytes []byte

func (b Bytes) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]string{"$u8": base64.StdEncoding.EncodeToString(b)})
}

func (b *Bytes) UnmarshalJSON(d []byte) error {
	var m map[string]string
	if err := json.Unmarshal(d, &m); err != nil {
		return err
	}
	v, err := base64.StdEncoding.DecodeString(m["$u8"])
	*b = v
	return err
}

// EncodeWire：事件帧总带 data——没有载荷的事件（*.changed 等，契约里是 z.null()）发 null，同 TS 事件总线；
// 省掉的话视图收到 undefined，过不了事件校验被丢弃
func EncodeWire(f ServerFrame) ([]byte, error) {
	if f.T == "event" && f.Data == nil {
		return json.Marshal(struct {
			T     string `json:"t"`
			Event string `json:"event"`
			Data  any    `json:"data"`
		}{f.T, f.Event, nil})
	}
	return json.Marshal(f)
}
