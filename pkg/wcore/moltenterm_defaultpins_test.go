// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import "testing"

// #1709: a fresh install's top row starts empty, so a new client carries no seeding mark.
func TestFirstLaunchClientMetaPinsNothing(t *testing.T) {
	meta := firstLaunchClientMeta()
	if _, ok := meta[SeedGlobalPinsMetaKey]; ok {
		t.Fatalf("first launch meta = %v, want no %s", meta, SeedGlobalPinsMetaKey)
	}
}
