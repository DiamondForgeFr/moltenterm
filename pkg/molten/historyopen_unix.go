// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package molten

import (
	"os"
	"syscall"
)

// Refuse a final-component link and do not wait for a FIFO substituted after the path check.
func historyOpenNoBlock(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
}
