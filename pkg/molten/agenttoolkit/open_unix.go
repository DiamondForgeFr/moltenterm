// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package agenttoolkit

import (
	"os"
	"syscall"
)

func openNoBlock(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
}
