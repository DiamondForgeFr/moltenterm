// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build windows

package usage

import "os"

func openNoBlock(path string) (*os.File, error) {
	return os.Open(path)
}
