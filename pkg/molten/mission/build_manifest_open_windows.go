// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build windows

package mission

import "os"

func openBuildManifest(path string) (*os.File, error) {
	return os.Open(path)
}
