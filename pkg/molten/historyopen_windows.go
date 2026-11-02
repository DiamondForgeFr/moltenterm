// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package molten

import "os"

// Windows uses path and descriptor checks around the open; it does not provide Unix no-follow/nonblocking flags.
func historyOpenNoBlock(path string) (*os.File, error) {
	return os.Open(path)
}
