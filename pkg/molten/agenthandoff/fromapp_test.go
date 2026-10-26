// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

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
