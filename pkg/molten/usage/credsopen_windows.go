// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package usage

import "os"

func openNoBlock(path string) (*os.File, error) {
	return os.Open(path)
}
