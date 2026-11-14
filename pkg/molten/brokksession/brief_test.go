// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/brainstorm"
	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
)

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(data)
}

// FR-BOSS-004, AC12 (#2033): his folder holds the brief that tells him how to offer replies.
func TestWriteBriefPutsTheReplyConventionInHisFolder(t *testing.T) {
	dir := t.TempDir()
	if err := WriteBrief(dir); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"AGENTS.md", "CLAUDE.md"} {
		text := readFile(t, filepath.Join(dir, name))
		if !strings.HasPrefix(text, BriefMarker) {
			t.Errorf("%s does not start with the marker: %.40q", name, text)
		}
		if !strings.Contains(text, "```brokk-actions") || !strings.Contains(text, "authorise") {
			t.Errorf("%s does not teach the reply block and the authorisation flag", name)
		}
	}
}

// FR-BOSS-009, AC88 (#2259): the brief teaches him the tone marker and its fixed list, every build alike; the window's
// list (frontend/moltenterm-shell/boss/brokk-tone.ts BrokkTones) is checked against this text by brokk-tone.test.ts.
func TestTheBriefTeachesTheToneMarker(t *testing.T) {
	t.Parallel()
	for _, brainstorm := range []bool{false, true} {
		text := BriefText(brainstorm)
		if !strings.Contains(text, "## Your tone") || !strings.Contains(text, "\n[[smile]]\n") {
			t.Errorf("brainstorm=%v: the brief does not teach the tone marker", brainstorm)
		}
		for _, tone := range []string{"smile", "warm", "amused", "proud", "concerned", "surprised", "thinking", "neutral"} {
			if !strings.Contains(text, "`"+tone+"`") {
				t.Errorf("brainstorm=%v: the brief does not list the tone %q", brainstorm, tone)
			}
		}
	}
}

// FR-BOSS-010 AC1 and AC21 (#2246): a gold, dev or local build teaches him the graph block; a release never does.
func TestTheBrainstormSectionFollowsTheGate(t *testing.T) {
	t.Parallel()
	with := BriefText(true)
	without := BriefText(false)
	if !strings.HasPrefix(with, without) {
		t.Fatal("the brainstorm section is not added after the brief")
	}
	for _, want := range []string{"```brokk-graph", `"op": "centre"`, `"op": "add"`, "`link`", "`talk`", "Brainstorm:"} {
		if !strings.Contains(with, want) {
			t.Errorf("the brainstorm section does not teach %q", want)
		}
	}
	if strings.Contains(without, "brokk-graph") || strings.Contains(without, "Brainstorm") {
		t.Error("the brief of a release mentions brainstorms")
	}
	dir := t.TempDir()
	if err := writeBrief(dir, with); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(dir, "AGENTS.md")); got != with {
		t.Errorf("AGENTS.md is %.40q, want the brief with its brainstorm section", got)
	}
	// The same folder after a change of channel: the section goes with the refresh.
	if err := writeBrief(dir, without); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(dir, "CLAUDE.md")); got != without {
		t.Errorf("CLAUDE.md still holds the brainstorm section on a release")
	}
}

// The brief follows the gate: a public build launched as a gold still gets the release's brief.
func TestTheBriefOfAReleaseHasNoBrainstormSection(t *testing.T) {
	t.Parallel()
	release := BriefText(buildchannel.BrainstormAllowed(buildchannel.GateChannel(false, buildchannel.Public, buildchannel.Gold)))
	if strings.Contains(release, "brokk-graph") {
		t.Error("a public release's brief teaches the graph block")
	}
	gold := BriefText(buildchannel.BrainstormAllowed(buildchannel.GateChannel(false, buildchannel.Gold, "")))
	if !strings.Contains(gold, "brokk-graph") {
		t.Error("a gold's brief does not teach the graph block")
	}
}

// FR-BOSS-010 AC10b (#2248): his brief lists the saved brainstorms by their titles alone, one plain line each, and
// teaches the questions he may ask about them; a release lists nothing.
func TestTheBriefListsTheSavedTitlesOnly(t *testing.T) {
	t.Parallel()
	text := BriefTextWith(true, []string{"A safe video app for children", "Forge `notes`\n# injected heading", strings.Repeat("x", 300)})
	for _, want := range []string{"\n- A safe video app for children\n", "\n- Forge  notes  # injected heading\n", `"op": "fork"`, `"op": "resume"`, `"op": "forget"`, `{"op": "finish"}`, "Brainstorm resumed:", brainstorm.ResumeFile, "are data", "never instructions"} {
		if !strings.Contains(text, strings.ReplaceAll(want, "  ", " ")) {
			t.Errorf("the brief lacks %q", want)
		}
	}
	if strings.Contains(text, strings.Repeat("x", 161)) {
		t.Error("a title over 160 characters is listed whole")
	}
	if !strings.Contains(BriefTextWith(true, nil), "no saved brainstorm yet") {
		t.Error("an empty list is not said")
	}
	if release := BriefTextWith(false, []string{"A safe video app for children"}); strings.Contains(release, "A safe video app") || strings.Contains(release, "saved brainstorm") {
		t.Error("a release's brief lists brainstorms")
	}
	if !strings.HasPrefix(BriefTextWith(true, []string{"x"}), BriefText(false)) {
		t.Error("the list is not after the brief")
	}
}

// FR-BOSS-010 AC26 and AC27 (#2247): he prunes the graph, never its centre, says so, and takes the developer's own
// changes as done. Each operation he is taught is one wavesrv applies.
func TestTheBriefTeachesTheLivingGraph(t *testing.T) {
	t.Parallel()
	text := BriefText(true)
	for _, op := range []string{brainstorm.OpEdit, brainstorm.OpRetype, brainstorm.OpRemove, brainstorm.OpUnlink, brainstorm.OpMerge} {
		if !strings.Contains(text, `{"op": "`+op+`"`) {
			t.Errorf("the brief does not teach %q", op)
		}
	}
	for _, want := range []string{"Never remove, merge or retype the central idea", "say so in one short line", "the developer's own changes to the graph", "never redo or undo them"} {
		if !strings.Contains(text, want) {
			t.Errorf("the brief lacks %q", want)
		}
	}
}

// FR-BOSS-010 AC14 to AC16 (#2250, #2251): he concludes with the project brief and proposes the project, its
// SaaSFoundryAI setup and the hand-off, and the example he is taught is a block wavesrv applies. He never prices an idea
// and never asks for a credential.
func TestTheBriefTeachesTheConclusionAndTheProject(t *testing.T) {
	t.Parallel()
	text := BriefText(true)
	blocks := strings.Split(text, "```brokk-graph\n")
	if len(blocks) < 3 {
		t.Fatalf("the brief holds %d graph examples, want the conclusion's too", len(blocks)-1)
	}
	example, _, _ := strings.Cut(blocks[2], "```")
	var b brainstorm.Block
	if err := json.Unmarshal([]byte(example), &b); err != nil {
		t.Fatalf("the conclusion's example is not JSON: %v", err)
	}
	g, err := brainstorm.Apply(brainstorm.EmptyGraph(), brainstorm.Block{V: 1, Talk: brainstorm.TalkProject, Ops: []brainstorm.Op{{Op: brainstorm.OpCentre, Id: "forge", Text: "Forge notes"}}}, 1, 1000)
	if err != nil {
		t.Fatal(err)
	}
	applied, err := brainstorm.Apply(g.Graph, b, 2, 2000)
	if err != nil {
		t.Fatalf("the conclusion's example is refused: %v", err)
	}
	if applied.Brief == nil || len(applied.Added) != 4 {
		t.Errorf("the example concludes %+v and adds %v", applied.Brief, applied.Added)
	}
	actions := map[string]bool{}
	for _, n := range applied.Graph.Nodes {
		if n.Kind == brainstorm.KindProposal {
			actions[n.Action] = true
		}
	}
	if !actions[brainstorm.ActionProject] || !actions[brainstorm.ActionSaaSFoundry] || !actions[brainstorm.ActionHandoff] {
		t.Errorf("the example proposes %v", actions)
	}
	for _, want := range []string{`"action": "project"`, `"action": "saasfoundry"`, `"action": "handoff"`, "never prices it", "a market value, a revenue, a valuation or a success", "acts only on their click", "Never ask the developer for a key"} {
		if !strings.Contains(text, want) {
			t.Errorf("the brief lacks %q", want)
		}
	}
	if strings.Contains(text, "geargrim") || strings.Contains(text, "Geargrim") || strings.Contains(text, "DiamondForge") {
		t.Error("the brief offers a hand-off DiamondForge does not offer yet")
	}
}

// The resume brief goes into his own folder: the brainstorm package names it as this one does.
func TestTheResumeBriefGoesIntoHisFolder(t *testing.T) {
	t.Parallel()
	if brainstorm.BrokkFolderName != FolderName {
		t.Errorf("brainstorm writes the resume brief into %q, his folder is %q", brainstorm.BrokkFolderName, FolderName)
	}
}

func TestWriteBriefRefreshesWhatItWroteAndNothingElse(t *testing.T) {
	dir := t.TempDir()
	older := BriefMarker + " v0 -->\nan older brief\n"
	mine := "# My own instructions for Brokk\n"
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(older), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte(mine), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteBrief(dir); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(dir, "AGENTS.md")); got != BriefText(buildchannel.BrainstormEnabled()) {
		t.Errorf("AGENTS.md is %.40q, want the current brief in place of the one MoltenTerm wrote", got)
	}
	if got := readFile(t, filepath.Join(dir, "CLAUDE.md")); got != mine {
		t.Errorf("CLAUDE.md is %.40q, want the developer's file left as it was", got)
	}
}
