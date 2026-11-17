// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build windows

package logwatch

import "os"

// identOf: a file's information carries no identity here, so the fingerprint of its first bytes tells files apart.
func identOf(info os.FileInfo) string {
	return ""
}
