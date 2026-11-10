package shellhandlers

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/theme"
)

// ThemeDialogs：主题包导入 / 导出用的系统对话框（取消返回 ""）
type ThemeDialogs struct {
	PickFile func(title, filterName string, exts []string) (string, error)
	SaveFile func(title, defaultName, filterName string, exts []string) (string, error)
}

// themeError：不合法的主题包给统一文案，原因写日志
func themeError(err error) error {
	switch {
	case errors.Is(err, theme.ErrInvalid):
		log.Printf("[theme] invalid theme: %v", err)
		return &contract.Error{Code: "BAD_INPUT", Message: i18n.T("electron.common.theme-pack-invalid")}
	case errors.Is(err, theme.ErrImage):
		log.Printf("[theme] background image: %v", err)
		return &contract.Error{Code: "BAD_INPUT", Message: i18n.T("electron.common.theme-image-unsupported", theme.MaxImageBytes>>20)}
	case errors.Is(err, theme.ErrTooMany):
		return &contract.Error{Code: "BAD_INPUT", Message: i18n.T("electron.common.theme-too-many", theme.MaxCustomThemes)}
	case errors.Is(err, theme.ErrNotFound):
		return &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
	default:
		return err
	}
}

// 取消对话框时回 null：结果帧的 output 是 omitempty，裸 nil 会被省掉（视图收到 undefined，过不了 nullable 校验），
// 带类型的空指针才编成 null
var (
	noTheme = (*theme.Custom)(nil)
	noPath  = (*string)(nil)
)

// installCustomThemes：theme.custom*（设置 → 外观 → 我的主题）
func installCustomThemes(r *contract.Router, svc *theme.Service, dlg ThemeDialogs) {
	r.Call("theme.customList", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return svc.ListCustom(), nil
	})
	r.Call("theme.customSave", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID string `json:"id"`
			theme.Pack
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
		}
		c, err := svc.SaveCustom(in.ID, in.Pack)
		if err != nil {
			return nil, themeError(err)
		}
		return c, nil
	})
	r.Call("theme.customDelete", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
		}
		return nil, themeError(svc.DeleteCustom(in.ID))
	})
	r.Call("theme.customImport", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		if dlg.PickFile == nil {
			return nil, &contract.Error{Code: "UNAVAILABLE", Message: "no file dialog"}
		}
		path, err := dlg.PickFile(i18n.T("electron.common.import-theme-pack"), i18n.T("electron.common.theme-pack"),
			[]string{"json", "nomitheme", "zip"})
		if err != nil || path == "" {
			return noTheme, err
		}
		c, err := svc.ImportFile(path)
		if err != nil {
			return nil, themeError(err)
		}
		return c, nil
	})
	// 拖进导入框的主题包：视图读出字节传来，与选文件导入同一套校验
	r.Call("theme.customImportData", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Data contract.Bytes `json:"data"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
		}
		c, err := svc.ImportData(in.Data)
		if err != nil {
			return nil, themeError(err)
		}
		return c, nil
	})
	r.Call("theme.customTemplate", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		if dlg.SaveFile == nil {
			return nil, &contract.Error{Code: "UNAVAILABLE", Message: "no file dialog"}
		}
		path, err := dlg.SaveFile(i18n.T("electron.common.save-theme-template"), "nomi-theme-template"+theme.PackExt,
			i18n.T("electron.common.theme-pack"), []string{"json"})
		if err != nil || path == "" {
			return noPath, err
		}
		if err := os.WriteFile(path, theme.Template(), 0o644); err != nil {
			return nil, err
		}
		return path, nil
	})
	r.Call("theme.customPickBackground", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		if dlg.PickFile == nil {
			return nil, &contract.Error{Code: "UNAVAILABLE", Message: "no file dialog"}
		}
		path, err := dlg.PickFile(i18n.T("electron.common.choose-theme-background"), i18n.T("electron.common.theme-image"),
			[]string{"png", "jpg", "jpeg", "webp"})
		if err != nil || path == "" {
			return noPath, err
		}
		url, err := svc.StageBackground(path)
		if err != nil {
			return nil, themeError(err)
		}
		return url, nil
	})
	r.Call("theme.customExport", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, &contract.Error{Code: "BAD_INPUT", Message: err.Error()}
		}
		if dlg.SaveFile == nil {
			return nil, &contract.Error{Code: "UNAVAILABLE", Message: "no file dialog"}
		}
		exts := []string{"json"}
		if svc.HasBackground(in.ID) {
			exts = []string{"nomitheme"}
		}
		path, err := dlg.SaveFile(i18n.T("electron.common.export-theme-pack"), svc.ExportName(in.ID),
			i18n.T("electron.common.theme-pack"), exts)
		if err != nil || path == "" {
			return noPath, err
		}
		if err := svc.ExportFile(in.ID, path); err != nil {
			return nil, themeError(err)
		}
		return path, nil
	})
}
