// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package projectviews

import (
	"reflect"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestSlotsRoundTripAndLoseTheTabsThatAreGone(t *testing.T) {
	meta := waveobj.MetaMapType{SlotsMetaKey: map[string]any{"a": "s1", "b": "s1", "c": "s2", "": "s3", "d": 4}}
	slots := ReadSlots(meta)
	if !reflect.DeepEqual(slots, map[string]string{"a": "s1", "b": "s1", "c": "s2"}) {
		t.Fatalf("slots %v", slots)
	}
	if got := PruneSlots([]string{"a", "c"}, slots); !reflect.DeepEqual(got, map[string]string{"a": "s1", "c": "s2"}) {
		t.Fatalf("pruned %v", got)
	}
}
