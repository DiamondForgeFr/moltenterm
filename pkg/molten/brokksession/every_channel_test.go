// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
)

// FR-BOSS-010 AC1 (#2320): the brainstorm section of his brief is there on every channel, a release candidate and a
// public release included, and a state Features in test stored on a gold (the brainstorm off, the public version) no
// longer takes it out. It changes the gate channel by hand, so it is not parallel.
func TestTheBriefTeachesTheBrainstormOnEveryChannel(t *testing.T) {
	stale := map[string]buildchannel.Narrowing{
		"nothing stored":      {},
		"the brainstorm off":  {Off: []string{"brainstorm"}},
		"the public version":  {Public: true},
		"both":                {Public: true, Off: []string{"brainstorm"}},
		"another feature off": {Off: []string{"another"}},
	}
	for _, channel := range []string{buildchannel.Dev, buildchannel.Local, buildchannel.Gold, buildchannel.RC, buildchannel.Public} {
		dir := t.TempDir()
		restore := buildchannel.StartAsForTest(channel, buildchannel.Narrowing{})
		version, text, err := CurrentBrief(dir)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(text, "brokk-graph") {
			t.Errorf("a %s build's brief does not teach the graph block", channel)
		}
		for name, state := range stale {
			buildchannel.UseNarrowing(func() buildchannel.Narrowing { return state })
			nextVersion, next, err := CurrentBrief(dir)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(next, "brokk-graph") {
				t.Errorf("%s on a %s build: the brief leaves the graph block out", name, channel)
			}
			if nextVersion != version {
				t.Errorf("%s on a %s build: the brief changed for a state that does not concern it", name, channel)
			}
			for _, file := range []string{"AGENTS.md", "CLAUDE.md"} {
				if got := readFile(t, filepath.Join(dir, file)); got != next {
					t.Errorf("%s on a %s build: %s is not the current brief", name, channel, file)
				}
			}
		}
		restore()
	}
}

// A build that cannot say what channel it is teaches him nothing: nothing would read the block.
func TestTheBriefLeavesTheBrainstormOutWhereTheChannelIsNotKnown(t *testing.T) {
	for _, channel := range []string{buildchannel.Unknown, ""} {
		restore := buildchannel.StartAsForTest(channel, buildchannel.Narrowing{})
		_, text, err := CurrentBrief(t.TempDir())
		restore()
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(text, "brokk-graph") {
			t.Errorf("a build on %q teaches the graph block", channel)
		}
	}
}
