// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !darwin && !linux

package proctree

// Windows and the BSDs: agents are known from their command line and hooks only (documented gap).
func readProcs() ([]Proc, error) {
	return nil, ErrUnsupported
}
