// Package mediahandlers = apps/desktop-electron/internal/core/src/contract/media.ts 的语音输入 / 朗读部分（批次 9）：
// voice.* / tts.* / nav.openVoiceSettings。每个过程委派给服务的公开方法，事件由服务直接发布。
package mediahandlers

import (
	"context"
	"encoding/json"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/tts"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/voice"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Deps：服务与宿主动作
type Deps struct {
	Voice  *voice.Service
	TTS    *tts.Service
	Mascot voice.MascotConfig
	Logf   func(string, ...any)
	// OpenVoiceSettings = ports.windows.open('chat', { route: 'voice' })：显示对话窗口 + nav.voiceSettingsRequested
	OpenVoiceSettings func()

	streams *voiceStreams // 测试注入（Node createVoiceStreams() 的实例）
}

func bad(msg string) error { return &contract.Error{Code: "BAD_INPUT", Message: msg} }

// parseObj：输入必须是对象（z.object）
func parseObj(raw json.RawMessage) (*util.Obj, error) {
	v, err := util.Parse(raw)
	if err != nil {
		return nil, bad(err.Error())
	}
	o, ok := v.(*util.Obj)
	if !ok {
		return nil, bad("expected object")
	}
	return o, nil
}

func str(o *util.Obj, k string, required bool) (string, error) {
	switch v := o.Get(k).(type) {
	case string:
		return v, nil
	case nil, util.JSUndefined:
		if !required {
			return "", nil
		}
	}
	return "", bad(k + ": expected string")
}

func bytesField(raw json.RawMessage, k string) ([]byte, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, bad(err.Error())
	}
	var b contract.Bytes
	if err := json.Unmarshal(m[k], &b); err != nil || m[k] == nil {
		return nil, bad(k + ": expected Uint8Array")
	}
	return b, nil
}

type call func(raw json.RawMessage) (any, error)

// Install 注册全部过程（surfaces 由 procs.Install 按生成表限制）
func Install(r *contract.Router, d Deps) {
	reg := func(name string, f call) {
		r.Call(name, func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) { return f(raw) })
	}
	regCtx := func(name string, f func(ctx context.Context, raw json.RawMessage) (any, error)) {
		r.Call(name, func(ctx context.Context, _ contract.Caller, raw json.RawMessage) (any, error) { return f(ctx, raw) })
	}
	v, t := d.Voice, d.TTS
	byID := func(raw json.RawMessage) (string, error) {
		o, err := parseObj(raw)
		if err != nil {
			return "", err
		}
		return str(o, "id", true)
	}

	// ── 语音输入 ──
	reg("voice.state", func(json.RawMessage) (any, error) { return v.State(), nil })
	reg("voice.setSettings", func(raw json.RawMessage) (any, error) {
		o, err := parseObj(raw)
		if err != nil {
			return nil, err
		}
		return v.SetSettings(o), nil
	})
	reg("voice.ackCloud", func(json.RawMessage) (any, error) { return v.AckCloud(), nil })
	reg("voice.download", func(raw json.RawMessage) (any, error) {
		id, err := byID(raw)
		if err != nil {
			return nil, err
		}
		return v.Download(id), nil
	})
	reg("voice.cancel", func(raw json.RawMessage) (any, error) {
		id, err := byID(raw)
		if err != nil {
			return nil, err
		}
		return v.Cancel(id), nil
	})
	reg("voice.remove", func(raw json.RawMessage) (any, error) {
		id, err := byID(raw)
		if err != nil {
			return nil, err
		}
		return v.Remove(id), nil
	})
	// VAD：Silero 留在渲染进程 WASM（D-B9-2），宿主只回能量检测
	reg("voice.vadOpen", func(json.RawMessage) (any, error) { return util.NewObj("kind", "energy"), nil })
	reg("voice.vadProb", func(json.RawMessage) (any, error) { return 0, nil })
	reg("voice.vadClose", func(json.RawMessage) (any, error) { return nil, nil })
	regCtx("voice.transcribe", func(ctx context.Context, raw json.RawMessage) (any, error) {
		o, err := parseObj(raw)
		if err != nil {
			return nil, err
		}
		wav, err := bytesField(raw, "wav")
		if err != nil {
			return nil, err
		}
		source, err := str(o, "source", false)
		if err != nil {
			return nil, err
		}
		if !o.Has("source") || o.Get("source") == nil {
			source = "chat"
		}
		purpose, err := str(o, "purpose", false)
		if err != nil {
			return nil, err
		}
		if purpose != "" && purpose != "command" && purpose != "wake" {
			return nil, bad("purpose: invalid enum value")
		}
		return v.TranscribeResult(context.WithoutCancel(ctx), wav, source, purpose), nil
	})
	reg("voice.activity", func(raw json.RawMessage) (any, error) {
		o, err := parseObj(raw)
		if err != nil {
			return nil, err
		}
		if _, err := str(o, "activity", true); err != nil {
			return nil, err
		}
		if _, err := str(o, "source", true); err != nil {
			return nil, err
		}
		return v.ReportActivity(o.Get("activity"), o.Get("source")), nil
	})
	reg("voice.sendToChat", func(raw json.RawMessage) (any, error) {
		o, err := parseObj(raw)
		if err != nil {
			return nil, err
		}
		text, err := str(o, "text", true)
		if err != nil {
			return nil, err
		}
		v.SendToChat(util.UTF16Slice0(text, 4000))
		return nil, nil
	})
	reg("voice.volcSetKey", func(raw json.RawMessage) (any, error) {
		o, err := parseObj(raw)
		if err != nil {
			return nil, err
		}
		if _, err := str(o, "key", true); err != nil {
			return nil, err
		}
		return v.SetVolcKey(o.Get("key")), nil
	})
	reg("voice.volcClearKey", func(json.RawMessage) (any, error) { return v.ClearVolcKey(), nil })
	reg("voice.volcTest", func(json.RawMessage) (any, error) { return v.VolcTest(), nil })
	// 流式识别（豆包 2.0）：第一条 chunk 是启动结果，之后是这个会话的临时结果 / 错误；stop / cancel 后流结束
	streams := d.streams
	if streams == nil {
		streams = newVoiceStreams()
	}
	r.Stream("voice.streamStart", func(ctx context.Context, c contract.Caller, raw json.RawMessage, emit func(any) error) (any, error) {
		o, err := parseObj(raw)
		if err != nil {
			return nil, err
		}
		source, err := str(o, "source", true)
		if err != nil {
			return nil, err
		}
		wc := streams.senderFor(c)
		res := v.StreamStart(wc, source)
		if res.Get("ok") != true {
			if err := emit(util.NewObj("type", "start").Assign(res)); err != nil {
				return nil, err
			}
			return nil, nil
		}
		sid := res.Get("id").(string)
		ps := newPushStream()
		streams.open(sid, wc.ID(), ps)
		ps.push(util.NewObj("type", "start", "ok", true, "id", sid))
		for {
			items, done := ps.next()
			for _, it := range items {
				if err := emit(it); err != nil {
					v.StreamCancel(wc, sid)
					streams.close(sid, wc.ID())
					return nil, err
				}
			}
			if done {
				return nil, nil
			}
			select {
			case <-ps.wake:
			case <-ctx.Done():
				// 调用被取消（abort 帧、窗口断开）：撤销会话并结束流
				v.StreamCancel(wc, sid)
				streams.close(sid, wc.ID())
				return nil, ctx.Err()
			}
		}
	})
	r.Call("voice.streamPush", func(_ context.Context, c contract.Caller, raw json.RawMessage) (any, error) {
		o, err := parseObj(raw)
		if err != nil {
			return nil, err
		}
		id, err := str(o, "id", true)
		if err != nil {
			return nil, err
		}
		pcm, err := bytesField(raw, "pcm")
		if err != nil {
			return nil, err
		}
		if pcm == nil {
			pcm = []byte{}
		}
		return v.StreamPush(streams.senderFor(c), id, pcm), nil
	})
	r.Call("voice.streamStop", func(_ context.Context, c contract.Caller, raw json.RawMessage) (any, error) {
		id, err := byID(raw)
		if err != nil {
			return nil, err
		}
		wc := streams.senderFor(c)
		defer streams.close(id, wc.ID())
		return v.StreamStop(wc, id), nil
	})
	r.Call("voice.streamCancel", func(_ context.Context, c contract.Caller, raw json.RawMessage) (any, error) {
		id, err := byID(raw)
		if err != nil {
			return nil, err
		}
		wc := streams.senderFor(c)
		ok := v.StreamCancel(wc, id)
		streams.close(id, wc.ID())
		return ok, nil
	})
	reg("voice.getMascotSettings", func(json.RawMessage) (any, error) {
		s := voice.GetMascotVoiceSettings(d.Mascot)
		if _, u := s.(util.JSUndefined); u {
			return nil, nil
		}
		return s, nil
	})
	reg("voice.saveMascotSettings", func(raw json.RawMessage) (any, error) {
		o, err := parseObj(raw)
		if err != nil {
			return nil, err
		}
		voice.SaveMascotVoiceSettings(d.Mascot, o, d.Logf, r.Emit)
		return nil, nil
	})

	// ── 朗读 ──
	reg("tts.getConfig", func(json.RawMessage) (any, error) { return t.GetConfig(), nil })
	reg("tts.saveConfig", func(raw json.RawMessage) (any, error) {
		in, err := util.Parse(raw)
		if err != nil {
			return nil, bad(err.Error())
		}
		if _, err := t.SaveConfig(in); err != nil {
			return nil, err
		}
		return nil, nil
	})
	reg("tts.testConnection", func(raw json.RawMessage) (any, error) {
		in, err := util.Parse(raw)
		if err != nil {
			return nil, bad(err.Error())
		}
		return t.TestConnection(in), nil
	})
	reg("tts.resetConfig", func(json.RawMessage) (any, error) { return nil, t.ResetConfig() })
	reg("tts.voices", func(json.RawMessage) (any, error) { return t.Voices(), nil })
	reg("tts.preview", func(raw json.RawMessage) (any, error) {
		o, err := parseObj(raw)
		if err != nil {
			return nil, err
		}
		text, err := str(o, "text", true)
		if err != nil {
			return nil, err
		}
		provider, err := str(o, "provider", true)
		if err != nil {
			return nil, err
		}
		var ev *string
		if s, ok := o.Get("edgeVoice").(string); ok {
			ev = &s
		} else if _, err := str(o, "edgeVoice", false); err != nil {
			return nil, err
		}
		var rate *float64
		switch x := o.Get("rate").(type) {
		case float64:
			rate = &x
		case nil, util.JSUndefined:
		default:
			return nil, bad("rate: expected number")
		}
		return t.Preview(text, provider, ev, rate), nil
	})
	reg("tts.status", func(json.RawMessage) (any, error) { return t.Status(), nil })
	reg("tts.stop", func(json.RawMessage) (any, error) { return t.Stop(), nil })
	reg("tts.reply", func(raw json.RawMessage) (any, error) {
		in, err := util.Parse(raw)
		if err != nil {
			return nil, bad(err.Error())
		}
		if err := validReply(in); err != nil {
			return nil, err
		}
		return t.Reply(in), nil
	})
	reg("tts.speak", func(raw json.RawMessage) (any, error) {
		o, err := parseObj(raw)
		if err != nil {
			return nil, err
		}
		text, err := str(o, "text", true)
		if err != nil {
			return nil, err
		}
		return t.Speak(text), nil
	})
	reg("tts.health", func(raw json.RawMessage) (any, error) {
		var provider *string
		if len(raw) > 0 && string(raw) != "null" {
			o, err := parseObj(raw)
			if err != nil {
				return nil, err
			}
			if s, ok := o.Get("provider").(string); ok {
				provider = &s
			} else if _, err := str(o, "provider", false); err != nil {
				return nil, err
			}
		}
		return t.Health(provider), nil
	})
	reg("tts.promptVoice", func(json.RawMessage) (any, error) { return t.PromptVoice(), nil })

	// ── 导航 ──
	reg("nav.openVoiceSettings", func(json.RawMessage) (any, error) {
		if d.OpenVoiceSettings != nil {
			d.OpenVoiceSettings()
		}
		return nil, nil
	})
}

func validReply(in any) error {
	o, ok := in.(*util.Obj)
	if !ok {
		return bad("expected object")
	}
	op, _ := o.Get("op").(string)
	switch op {
	case "say":
		if _, err := str(o, "id", true); err != nil {
			return err
		}
		_, err := str(o, "text", true)
		return err
	case "end":
		_, err := str(o, "id", true)
		return err
	case "stop":
		_, err := str(o, "id", false)
		return err
	}
	return bad("op: invalid union")
}
