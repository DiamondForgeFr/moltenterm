// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package mission

import (
	"os"
	"syscall"
)

// The path may be replaced with a FIFO between its stat and open.
func openBuildManifest(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
}
