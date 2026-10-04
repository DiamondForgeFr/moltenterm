// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/sessions"
)

// The durable sessions (FR-SHELL-020) start with Mission Control (mission.Start, already called by main): the
// sessions package imports Wave's job controller, which imports packages importing Mission Control, so Mission
// Control cannot import it and the main package wires them.
func init() {
	mission.UseStarter(sessions.Start)
}
