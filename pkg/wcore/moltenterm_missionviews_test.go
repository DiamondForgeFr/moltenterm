// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wcore

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestLegacyTimelineBlocksInProject(t *testing.T) {
	timeline := &waveobj.Block{OID: "tl", Meta: waveobj.MetaMapType{"view": "molten-timeline"}}
	project := &waveobj.Block{OID: "p", Meta: waveobj.MetaMapType{"view": molten.ProjectOverviewView}}
	cicd := &waveobj.Block{OID: "c", Meta: waveobj.MetaMapType{"view": "molten-cicd"}}
	got := legacyTimelineBlocksInProject([]*waveobj.Block{timeline, project, cicd, nil})
	if len(got) != 1 || got[0].OID != "tl" || got[0].Meta.GetString("view", "") != molten.ProjectOverviewView {
		t.Fatalf("only the Timeline block migrates, to the Project view: got %v", got)
	}
	if timeline.Meta.GetString("view", "") != "molten-timeline" {
		t.Errorf("the blocks read must not be modified")
	}
	if again := legacyTimelineBlocksInProject(got); len(again) != 0 {
		t.Errorf("a second run migrates nothing: got %v", again)
	}
}
