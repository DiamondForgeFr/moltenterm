// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build windows

package mission

func processGroupOf(pid int) int {
	return 0
}

func stopProcess(pid int) error {
	return stopRunGroup(pid)
}

func killProcess(pid int) error {
	return stopRunGroup(pid)
}
