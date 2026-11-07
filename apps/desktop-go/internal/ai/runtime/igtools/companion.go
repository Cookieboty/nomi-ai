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

// CompanionTools = CompanionToolsPlugin(autoConfirm)：dangerous = !autoConfirm（显式声明）。
// available：桌面角色在不在（关掉时这一轮不把手势 / 情绪工具发给模型，省一次只为做动作的往返）；nil = 总是提供
func CompanionTools(avatar Avatar, autoConfirm bool, available func() bool) []tools.Definition {
	ok := func() *u.Obj { return u.NewObj("ok", true) }
	return []tools.Definition{
		{
			Name: "avatar_gesture",
			// 手势名本身就是英文词义（wave / nod / think…），不再在描述里逐个翻译一遍（每次请求都带）
			Description: "让桌面角色做一个手势，name 按字面意思选（如 wave 挥手、nod 点头、think 思考、cheer 加油）。当前角色没有的手势会被忽略。",
			Input:       schema(gestureSchemaT, "%E", enumJSON(charcontract.SemanticGestures)),
			Dangerous:   !autoConfirm,
			Available:   available,
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
			Available: available,
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
