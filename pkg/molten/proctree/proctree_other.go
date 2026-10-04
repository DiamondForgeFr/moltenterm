// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

//go:build !darwin && !linux

package proctree

// Windows and the BSDs: agents are known from their command line and hooks only (documented gap).
func readProcs() ([]Proc, error) {
	return nil, ErrUnsupported
}
