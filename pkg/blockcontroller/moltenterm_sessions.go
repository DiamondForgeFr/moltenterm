// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/sessions"
)

// The durable sessions (FR-SHELL-020) start with Mission Control (mission.Start, called by wavesrv's main): the
// sessions package imports Wave's job controller, which imports packages importing Mission Control, so Mission Control
// cannot import it. wavesrv's main is built from its main file alone, so the wiring lives in a package it imports.
func init() {
	mission.UseStarter(sessions.Start)
}
