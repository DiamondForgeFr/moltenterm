// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import "github.com/wavetermdev/waveterm/pkg/waveobj"

// A fresh install's top row started with Terminal, Web page, Pilotage and Project pinned everywhere (#1296), written
// by the first window that saw SeedGlobalPinsMetaKey on the client. Since #1709 MoltenTerm pins nothing on its own: a
// fresh install's top row starts empty and only the views the user pins everywhere fill it, so the mark is no longer
// set. The windows still honour a mark an earlier version left on a client that never showed a window. must match
// SeedGlobalPinsMetaKey in frontend/moltenterm-shell/sidebar/default-pins.ts
const SeedGlobalPinsMetaKey = "molten:seedglobalpins"

func firstLaunchClientMeta() waveobj.MetaMapType {
	return waveobj.MetaMapType{}
}
