// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !darwin && !linux

package proctree

// Windows and the BSDs have no process table reader either (proctree_other.go).
func readCpu(pid int32) (Cpu, bool) {
	return Cpu{}, false
}
