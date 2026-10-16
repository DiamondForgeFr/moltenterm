// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !darwin && !linux

package proctree

// OpenFiles is not read on this platform: listing a process's handles on Windows walks the whole system's.
func OpenFiles(pid int32) []string {
	return nil
}
