// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestProjectOverviewBlockMeta(t *testing.T) {
	src := waveobj.MetaMapType{"view": "molten-timeline", "frame:title": "kept"}
	got, changed := ProjectOverviewBlockMeta(src)
	if !changed || got.GetString("view", "") != ProjectOverviewView || got.GetString("frame:title", "") != "kept" {
		t.Errorf("a Timeline block opens the Project view and keeps its other keys: got %v", got)
	}
	if src.GetString("view", "") != "molten-timeline" {
		t.Errorf("the meta passed must not be modified")
	}
	for _, view := range []string{"molten-project", "molten-cicd", "term", ""} {
		meta := waveobj.MetaMapType{"view": view}
		if _, changed := ProjectOverviewBlockMeta(meta); changed {
			t.Errorf("view %q is left as it is", view)
		}
	}
	if got, changed := ProjectOverviewBlockMeta(nil); changed || got != nil {
		t.Errorf("no meta stays nil")
	}
}
