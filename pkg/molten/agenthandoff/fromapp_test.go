// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthandoff

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// MoltenTerm's own request (#1143) asks no approval, is typed at the receiver's idle prompt, says it comes from
// MoltenTerm, and asks for the outcome line next to the brief.
func TestSendFromAppTypesWithoutApproval(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	sent, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockA", Goal: "Remove the worktree /w.", Context: "Project: /p."})
	if err != nil || sent.Status != StatusDelivered || sent.To != "Camille" || sent.OutcomePath != OutcomePathOf(sent.BriefPath) {
		t.Fatalf("sent: %+v %v", sent, err)
	}
	if len(env.notifications()) != 0 {
		t.Fatalf("no approval is asked: %+v", env.notifications())
	}
	lines := env.typedLines()
	if len(lines) != 1 || lines[0].blockId != "blockA" || !strings.HasPrefix(lines[0].line, "[From MoltenTerm] Remove the worktree /w.") ||
		!strings.Contains(lines[0].line, sent.BriefPath) {
		t.Fatalf("typed: %+v", lines)
	}
	data, err := os.ReadFile(sent.BriefPath)
	if err != nil {
		t.Fatal(err)
	}
	brief := string(data)
	for _, want := range []string{"# Request from MoltenTerm to Camille", "on the developer's click", "no other agent and no page wrote it",
		"Remove the worktree /w.", "Project: /p.", sent.OutcomePath, "`needs you:`"} {
		if !strings.Contains(brief, want) {
			t.Fatalf("brief lacks %q:\n%s", want, brief)
		}
	}
}

// A busy receiver gets it queued; a terminal without an agent or a remote one gets nothing.
func TestSendFromAppQueuesOrRefuses(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	env.setState("blockB", molten.AgentStateWorking)
	sent, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockB", Goal: "Remove it."})
	if err != nil || sent.Status != StatusQueued {
		t.Fatalf("queued: %+v %v", sent, err)
	}
	env.setState("blockB", molten.AgentStateIdle)
	waitFor(t, "the queued request typed", func() bool { return len(env.typedLines()) == 1 })
	if _, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockShell", Goal: "x"}); err == nil {
		t.Fatalf("a terminal without an agent cannot take it")
	}
	if _, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockR", Goal: "x"}); err == nil {
		t.Fatalf("a remote terminal cannot take it")
	}
}

// A request with its own closing (#1779) does not ask for the outcome line MoltenTerm does not follow.
func TestSendFromAppClosingReplacesTheOutcomeLine(t *testing.T) {
	m, _, _, _ := makeFixture(t)
	sent, err := m.SendFromApp(context.Background(), AppRequest{ToBlockId: "blockA", Goal: "Resume PR #7.", Closing: "Say so in one line, then end your turn."})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(sent.BriefPath)
	if err != nil {
		t.Fatal(err)
	}
	brief := string(data)
	if !strings.Contains(brief, "## Then\n\nSay so in one line, then end your turn.") || strings.Contains(brief, "needs you:") ||
		strings.Contains(brief, "outcome.txt") {
		t.Fatalf("brief:\n%s", brief)
	}
}

// The lead is found by the sub-agent registry's terminal, or by a signed first name of the same CLI in the same project;
// a name another CLI or another project holds is not the lead (#1779).
func TestFindLead(t *testing.T) {
	m, _, projA, projB := makeFixture(t)
	ctx := context.Background()
	cases := []struct {
		name  string
		query LeadQuery
		want  string
	}{
		{"signed name, case and accents folded", LeadQuery{FirstName: "camille", Agent: molten.AgentIdClaude, ProjectDir: projA}, "blockA"},
		{"signed name, CLI unknown", LeadQuery{FirstName: "Camille", ProjectDir: projA}, "blockA"},
		{"the registry's terminal wins over the name", LeadQuery{FirstName: "Nobody", BlockId: "blockB", ProjectDir: projA}, "blockB"},
		{"another CLI holds the name", LeadQuery{FirstName: "Camille", Agent: molten.AgentIdCodex, ProjectDir: projA}, ""},
		{"another project holds the name", LeadQuery{FirstName: "Camille", Agent: molten.AgentIdClaude, ProjectDir: projB}, ""},
		{"nobody holds the name", LeadQuery{FirstName: "Zoé", ProjectDir: projA}, ""},
		{"a remote agent is no lead", LeadQuery{FirstName: "Léa"}, ""},
		{"an empty query", LeadQuery{}, ""},
		{"the registry names a terminal without an agent", LeadQuery{BlockId: "blockShell"}, ""},
	}
	for _, c := range cases {
		found, ok := m.FindLead(ctx, c.query)
		if c.want == "" {
			if ok {
				t.Fatalf("%s: found %+v", c.name, found)
			}
			continue
		}
		if !ok || found.BlockId != c.want {
			t.Fatalf("%s: %+v %v", c.name, found, ok)
		}
	}
	found, _ := m.FindLead(ctx, LeadQuery{FirstName: "Camille", ProjectDir: projA})
	if found.FirstName != "Camille" || found.Agent != molten.AgentIdClaude || found.AgentName != "Claude Code" || found.WorkspaceId != "wsA" {
		t.Fatalf("found: %+v", found)
	}
}
