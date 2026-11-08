// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !darwin && !linux

package proctree

// OpenFiles is not read on this platform: listing a process's handles on Windows walks the whole system's.
func OpenFiles(pid int32) []string {
	return nil
}
