// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !darwin || !cgo

package termupdate

// Elsewhere a logout does not leave a surviving shell without the system's services in the same way: nothing is
// marked.
func readLoginStartMs() int64 {
	return 0
}
