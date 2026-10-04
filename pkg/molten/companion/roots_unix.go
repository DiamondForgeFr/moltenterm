// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package companion

import (
	"fmt"
	"os"
	"syscall"
)

// checkOwner accepts a folder the user owns that neither its group nor others can write to.
func checkOwner(info os.FileInfo) error {
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("writable by other users")
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("owner unknown")
	}
	if int(st.Uid) != os.Getuid() {
		return fmt.Errorf("owned by another user")
	}
	return nil
}
