package codinghandlers

// project.*：项目（core/projects）。文件夹的校验在 projects.Store 里（Check = 工作区根规则）。

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/contract"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/i18n"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/projects"
)

// projectErr：存储层的错误 → 契约错误码
func projectErr(err error) error {
	if errors.Is(err, projects.ErrNotFound) {
		return &contract.Error{Code: "PROJECT_NOT_FOUND", Message: err.Error()}
	}
	var fe *projects.FolderError
	if errors.As(err, &fe) {
		msg := fe.Reason
		if other, ok := strings.CutPrefix(fe.Reason, "nested:"); ok {
			msg = i18n.T("electron.common.project-folder-nested", fe.Dir, other)
		} else if fe.Dir != "" {
			msg = i18n.T("electron.common.project-folder-denied", fe.Dir, fe.Reason)
		}
		return &contract.Error{Code: "PROJECT_FOLDER_DENIED", Message: msg}
	}
	return err
}

// RegisterProjects：s 为 nil 时不注册（过程由 procs 补成 UNAVAILABLE）
func RegisterProjects(r *contract.Router, s *projects.Store) {
	if s == nil {
		return
	}
	r.Call("project.list", func(context.Context, contract.Caller, json.RawMessage) (any, error) {
		return s.List(), nil
	})
	r.Call("project.create", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			Name    string   `json:"name"`
			Primary string   `json:"primary"`
			Folders []string `json:"folders"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, err
		}
		v, err := s.Create(in.Name, in.Primary, in.Folders)
		if err != nil {
			return nil, projectErr(err)
		}
		return v, nil
	})
	r.Call("project.update", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID      string    `json:"id"`
			Name    *string   `json:"name"`
			Primary *string   `json:"primary"`
			Folders *[]string `json:"folders"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, err
		}
		var folders []string
		if in.Folders != nil {
			folders = *in.Folders
		}
		v, err := s.Update(in.ID, in.Name, in.Primary, folders, in.Folders != nil)
		if err != nil {
			return nil, projectErr(err)
		}
		return v, nil
	})
	r.Call("project.remove", func(_ context.Context, _ contract.Caller, raw json.RawMessage) (any, error) {
		var in struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &in); err != nil {
			return nil, err
		}
		if err := s.Remove(in.ID); err != nil {
			return nil, projectErr(err)
		}
		return nil, nil
	})
}
