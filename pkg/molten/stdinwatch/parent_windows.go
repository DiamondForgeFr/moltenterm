// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build windows

package stdinwatch

// ParentWatcher is nil on Windows: the parent pid stays the same after the parent exits and pids are reused, so a
// read error keeps shutting down as before #1043.
func ParentWatcher() func() bool {
	return nil
}

func Fd0State() string {
	return "unknown on this platform"
}
