// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import "github.com/wavetermdev/waveterm/pkg/waveobj"

// A fresh install's top row starts with Terminal, Web page, Pilotage and Project pinned everywhere (#1296). The pins
// carry names in the interface language, so the frontend writes them once, on seeing this mark, and clears it; an
// existing client never gets the mark, so a row the developer emptied stays empty. must match SeedGlobalPinsMetaKey in
// frontend/moltenterm-shell/sidebar/default-pins.ts
const SeedGlobalPinsMetaKey = "molten:seedglobalpins"

func firstLaunchClientMeta() waveobj.MetaMapType {
	return waveobj.MetaMapType{SeedGlobalPinsMetaKey: true}
}
