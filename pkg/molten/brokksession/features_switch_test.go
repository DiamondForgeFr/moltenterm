// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
)

// FR-BOSS-011 AC3 (#2254): the brainstorm section of his brief follows the developer's switch, at each brief: the next
// one after he turned the brainstorm off leaves it out, and it comes back when he turns it on. It changes the gate
// channel by hand, so it is not parallel.
func TestTheBriefLeavesTheBrainstormOutWhenItIsSwitchedOff(t *testing.T) {
	dir := t.TempDir()
	restore := buildchannel.StartAsForTest(buildchannel.Gold, buildchannel.Narrowing{})
	t.Cleanup(restore)

	version, text, err := CurrentBrief(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "brokk-graph") {
		t.Fatal("a gold's brief does not teach the graph block")
	}

	for name, state := range map[string]buildchannel.Narrowing{
		"the brainstorm off":  {Off: []string{buildchannel.FeatureBrainstorm}},
		"the public version":  {Public: true},
		"both":                {Public: true, Off: []string{buildchannel.FeatureBrainstorm}},
		"another feature off": {Off: []string{"another"}},
	} {
		buildchannel.UseNarrowing(func() buildchannel.Narrowing { return state })
		nextVersion, next, err := CurrentBrief(dir)
		if err != nil {
			t.Fatal(err)
		}
		shouldTeach := name == "another feature off"
		if strings.Contains(next, "brokk-graph") != shouldTeach {
			t.Errorf("%s: the brief teaches the graph block = %v, want %v", name, !shouldTeach, shouldTeach)
		}
		if shouldTeach && nextVersion != version {
			t.Errorf("%s: the brief changed for a switch that does not concern it", name)
		}
		if !shouldTeach && nextVersion == version {
			t.Errorf("%s: a running session is not told its brief changed", name)
		}
		for _, file := range []string{"AGENTS.md", "CLAUDE.md"} {
			if got := readFile(t, filepath.Join(dir, file)); got != next {
				t.Errorf("%s: %s is not the current brief", name, file)
			}
		}
		buildchannel.UseNarrowing(func() buildchannel.Narrowing { return buildchannel.Narrowing{} })
		if _, back, _ := CurrentBrief(dir); !strings.Contains(back, "brokk-graph") {
			t.Errorf("%s: the section does not come back when the switch is turned on", name)
		}
	}
}
