// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build windows

package companion

import (
	"os"
)

// Windows folders carry ACLs, not Unix modes: the folder's existence is what is checked (documented gap).
func checkOwner(info os.FileInfo) error {
	return nil
}
