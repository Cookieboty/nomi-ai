package hostports

import "golang.org/x/sys/windows"

// preferredLanguages = GetUserPreferredUILanguages(MUI_LANGUAGE_NAME)（Electron getPreferredSystemLanguages 在 Windows 上的来源）
func preferredLanguages() []string {
	l, err := windows.GetUserPreferredUILanguages(windows.MUI_LANGUAGE_NAME)
	if err != nil {
		return nil
	}
	return l
}
