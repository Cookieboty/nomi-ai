package igtools

import (
	"context"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/charcontract"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Avatar = AvatarService.gesture / emotion
type Avatar interface {
	AvatarGesture(name string) error
	AvatarEmotion(name string, weight *float64) error
}

// gestureHints = CompanionToolsPlugin GESTURE_HINTS
var gestureHints = map[string]string{
	"wave": "挥手", "greet": "打招呼", "nod": "点头", "shakeHead": "摇头", "bow": "鞠躬", "salute": "敬礼",
	"pray": "双手合十", "okHand": "OK 手势", "think": "托腮思考", "explain": "讲解", "eureka": "灵光一闪",
	"puzzled": "疑惑歪头", "listen": "倾听", "lookAround": "张望", "lookLeftRight": "左顾右盼", "peek": "偷看",
	"heart": "比心", "blowKiss": "送飞吻", "shy": "害羞", "coverFace": "捂脸", "apologize": "道歉",
	"surprise": "惊讶", "startle": "吓一跳", "sigh": "叹气", "smug": "得意", "aggrieved": "委屈",
	"tears": "流泪", "angry": "生气", "coldSweat": "冷汗", "daze": "发呆", "cheer": "加油握拳",
	"thumbsUp": "点赞", "peace": "剪刀手", "celebrate": "庆祝", "clap": "鼓掌", "hop": "开心跳动",
	"wink": "眨眼", "tongue": "吐舌", "cute": "卖萌", "reachOut": "伸手示意", "work": "打字工作",
	"yawn": "打哈欠", "stretch": "伸懒腰", "goodnight": "晚安", "hum": "哼歌", "random": "随机",
}

// CompanionTools = CompanionToolsPlugin(autoConfirm)：dangerous = !autoConfirm（显式声明）
func CompanionTools(avatar Avatar, autoConfirm bool) []tools.Definition {
	list := make([]string, len(charcontract.SemanticGestures))
	for i, g := range charcontract.SemanticGestures {
		list[i] = g + "（" + gestureHints[g] + "）"
	}
	ok := func() *u.Obj { return u.NewObj("ok", true) }
	return []tools.Definition{
		{
			Name:        "avatar_gesture",
			Description: "让桌面角色做一个手势。name 为语义手势：" + strings.Join(list, "、") + "。" + "当前角色没有对应动作的手势会被忽略。",
			Input:       schema(gestureSchemaT, "%E", enumJSON(charcontract.SemanticGestures)),
			Dangerous:   !autoConfirm,
			Execute: func(_ context.Context, in any, _ tools.ExecContext) (any, error) {
				o, err := parse(gestureIn, in)
				if err != nil {
					return nil, err
				}
				if err := avatar.AvatarGesture(o.Get("name").(string)); err != nil {
					return nil, err
				}
				return ok(), nil
			},
		},
		{
			Name: "avatar_emotion",
			Description: "切换桌面角色的情绪：" + strings.Join(charcontract.SemanticEmotions, " / ") +
				"（weight 0~1 为强度，数秒后自动恢复）。" + "当前角色没有对应表情的情绪会被忽略。",
			Input:     schema(emotionSchemaT, "%E", enumJSON(charcontract.SemanticEmotions)),
			Dangerous: !autoConfirm,
			Execute: func(_ context.Context, in any, _ tools.ExecContext) (any, error) {
				o, err := parse(emotionIn, in)
				if err != nil {
					return nil, err
				}
				var w *float64
				if x, isNum := o.Get("weight").(float64); isNum && o.Has("weight") {
					w = &x
				}
				if err := avatar.AvatarEmotion(o.Get("name").(string), w); err != nil {
					return nil, err
				}
				return ok(), nil
			},
		},
	}
}
