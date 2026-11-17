// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !windows

package logwatch

import (
	"fmt"
	"os"
	"syscall"
)

// identOf is a file's device and inode: a rename keeps them, a new file gets others.
func identOf(info os.FileInfo) string {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || st == nil {
		return ""
	}
	return fmt.Sprintf("%d:%d", st.Dev, st.Ino)
}
