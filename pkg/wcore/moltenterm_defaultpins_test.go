// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import "testing"

func TestFirstLaunchClientMetaMarksTheDefaultPins(t *testing.T) {
	meta := firstLaunchClientMeta()
	if meta[SeedGlobalPinsMetaKey] != true {
		t.Fatalf("first launch meta = %v, want %s: true", meta, SeedGlobalPinsMetaKey)
	}
}
