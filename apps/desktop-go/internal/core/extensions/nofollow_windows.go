//go:build windows

package extensions

// Windows 没有 O_NOFOLLOW；调用方随后用 Lstat/Stat 校验是普通文件（D-B8-9）。
const oNoFollow = 0
