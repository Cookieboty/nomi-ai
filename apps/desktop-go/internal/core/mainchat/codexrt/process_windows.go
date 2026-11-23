//go:build windows

package codexrt

import "os"

// Managed adoption is gated by convstore on Windows before any migration.
// Do not offer unproven process-tree cancellation on that platform either.
func killGroup(int)      {}
func groupGone(int) bool { return false }

func directoryIdentity(os.FileInfo) string { return "unsupported" }
