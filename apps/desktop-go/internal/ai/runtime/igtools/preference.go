package igtools

import (
	"context"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aifacade"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

// Profile = UserProfileService（seams/userProfile.ts）里工具用到的部分
type Profile interface {
	Get() any
	GetPath(path string) any
	Set(patch *u.Obj) (any, error)
	Reset() (any, error)
}

var _ Profile = (*aifacade.ProfileStore)(nil)

// PreferenceTools = createPreferenceTools(svc)
func PreferenceTools(svc Profile, env Env) []tools.Definition {
	ok := func() *u.Obj { return u.NewObj("ok", true) }
	return []tools.Definition{
		{
			Name:           "set_user_preference",
			Description:    "写入用户偏好（source=user，最高优先级）。path 为点路径，如 preferences.replyStyle",
			Input:          schema(setPrefSchema),
			DangerousUnset: true,
			Execute: func(_ context.Context, in any, _ tools.ExecContext) (any, error) {
				o, err := parse(setPrefIn, in)
				if err != nil {
					return nil, err
				}
				var conf *float64
				if c, isNum := o.Get("confidence").(float64); isNum && o.Has("confidence") {
					conf = &c
				}
				val := aifacade.Undef
				if o.Has("value") {
					val = o.Get("value")
				}
				if _, err := svc.Set(pathToPatch(o.Get("path").(string), val, conf, env.now())); err != nil {
					return nil, err
				}
				return ok(), nil
			},
		},
		{
			Name:           "get_user_preference",
			Description:    "读取用户偏好；path 为点路径。",
			Input:          schema(getPrefSchema),
			DangerousUnset: true,
			Execute: func(_ context.Context, in any, _ tools.ExecContext) (any, error) {
				o, err := parse(getPrefIn, in)
				if err != nil {
					return nil, err
				}
				r := u.NewObj()
				if v := svc.GetPath(o.Get("path").(string)); v != aifacade.Undef {
					r.Set("value", v)
				}
				return r, nil
			},
		},
		{
			// list / forget 不解析入参（Node execute 忽略 input）
			Name:           "list_user_preferences",
			Description:    "返回全部 profile（identity + preferences + habits + dislikes）。",
			Input:          schema(emptySchema),
			DangerousUnset: true,
			Execute: func(context.Context, any, tools.ExecContext) (any, error) {
				return svc.Get(), nil
			},
		},
		{
			Name:           "forget_user_preferences",
			Description:    "清空用户偏好薄层（重置为默认）。谨慎操作。",
			Input:          schema(emptySchema),
			DangerousUnset: true,
			Execute: func(context.Context, any, tools.ExecContext) (any, error) {
				if _, err := svc.Reset(); err != nil {
					return nil, err
				}
				return ok(), nil
			},
		},
	}
}

// pathToPatch：点路径 → deep partial；preferences.* 下非 {value} 对象的值包成 PreferenceValue
func pathToPatch(path string, value any, confidence *float64, now float64) *u.Obj {
	parts := strings.Split(path, ".")
	leaf := value
	if parts[0] == "preferences" {
		vo, isObj := value.(*u.Obj)
		if !(isObj && vo.Has("value")) {
			c := 1.0
			if confidence != nil {
				c = *confidence
			}
			w := u.NewObj()
			if value != aifacade.Undef {
				w.Set("value", value)
			}
			w.Set("source", "user")
			w.Set("updatedAt", now)
			w.Set("confidence", c)
			leaf = w
		}
	}
	root := u.NewObj()
	cur := root
	for _, p := range parts[:len(parts)-1] {
		n := u.NewObj()
		cur.Set(p, n)
		cur = n
	}
	if leaf != aifacade.Undef {
		cur.Set(parts[len(parts)-1], leaf)
	}
	return root
}
