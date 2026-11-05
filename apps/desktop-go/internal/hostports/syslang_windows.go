package hostports

import "golang.org/x/sys/windows"

// preferredLanguages = GetUserPreferredUILanguages(MUI_LANGUAGE_NAME)（系统首选语言）
func preferredLanguages() []string {
	l, err := windows.GetUserPreferredUILanguages(windows.MUI_LANGUAGE_NAME)
	if err != nil {
		return nil
	}
	return l
}
