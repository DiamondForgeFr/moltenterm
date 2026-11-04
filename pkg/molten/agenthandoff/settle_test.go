// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agenthandoff

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// stopsFixture: Camille (the lead, tokA) and Jérôme (tokB) in project A's folders, Salomé in project B; each agent's
// folder is on the branch the test names.
func stopsFixture(t *testing.T, branches map[string]string) (*Manager, *fakeEnv) {
	t.Helper()
	m, env, projA, projB := makeFixture(t)
	env.runs["blockJ"] = molten.AgentRunInfo{BlockId: "blockJ", Agent: molten.AgentIdCodex, Running: true, State: molten.AgentStateIdle, FirstName: "Julien"}
	env.locs["blockJ"] = Location{WorkspaceId: "wsA", WorkspaceName: "A", TabName: "T3", Folder: projA + "/wt-1872", ProjectDir: projA, Local: true}
	env.runs["blockS"] = molten.AgentRunInfo{BlockId: "blockS", Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Salomé"}
	env.locs["blockS"] = Location{WorkspaceId: "wsB", WorkspaceName: "B", TabName: "T4", Folder: projB + "/wt-1872", ProjectDir: projB, Local: true}
	old := FolderBranch
	FolderBranch = func(folder string) string { return branches[folder] }
	t.Cleanup(func() { FolderBranch = old })
	branches[projA+"/wt-1872"] = "feature/1872-flaky-backend"
	branches[projB+"/wt-1872"] = "feature/1872-other-project"
	return m, env
}

func TestSettleByTicketSettlesTheAgentsOfThatTicketInTheCallersProject(t *testing.T) {
	m, env := stopsFixture(t, map[string]string{})
	env.stops = map[string]string{"blockJ": molten.AgentSettleDone, "blockS": molten.AgentSettleDone}
	res, err := m.Settle(context.Background(), SettleRequest{Token: "tokA", Target: "#1872", Note: "  Backend\nis flaky,\t#1874 fixes it "})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Settled) != 1 || res.Settled[0].FirstName != "Julien" || res.By != "Camille" || res.Note != "Backend is flaky, #1874 fixes it" {
		t.Fatalf("settled: %+v", res)
	}
	calls := env.settleCalls()
	if len(calls) != 1 || calls[0] != (settleCall{"blockJ", "Camille", "Backend is flaky, #1874 fixes it"}) {
		t.Fatalf("only the caller's project and that ticket: %+v", calls)
	}
}

func TestSettleByNameAndItsRefusals(t *testing.T) {
	m, env := stopsFixture(t, map[string]string{})
	ctx := context.Background()
	env.stops = map[string]string{"blockJ": molten.AgentSettleDone}
	res, err := m.Settle(ctx, SettleRequest{Token: "tokA", Target: "julien"})
	if err != nil || len(res.Settled) != 1 || res.Settled[0].FirstName != "Julien" {
		t.Fatalf("by name, without case: %+v %v", res, err)
	}
	env.stops["blockJ"] = molten.AgentSettleNone
	if _, err := m.Settle(ctx, SettleRequest{Token: "tokA", Target: "Julien"}); err == nil || !strings.Contains(err.Error(), "nothing to settle") {
		t.Fatalf("no stop: %v", err)
	}
	env.stops["blockJ"] = molten.AgentSettleOwnPrompt
	if _, err := m.Settle(ctx, SettleRequest{Token: "tokA", Target: "Julien"}); err == nil || !strings.Contains(err.Error(), "prompt of its own terminal") {
		t.Fatalf("own prompt: %v", err)
	}
	if _, err := m.Settle(ctx, SettleRequest{Token: "tokA", Target: "camille"}); err == nil || err.Error() != errSettleSelf {
		t.Fatalf("an agent never settles its own stop: %v", err)
	}
	if _, err := m.Settle(ctx, SettleRequest{Token: "tokA", Target: "Zoé"}); err == nil || !strings.Contains(err.Error(), "No active agent is named") {
		t.Fatalf("unknown name: %v", err)
	}
	if _, err := m.Settle(ctx, SettleRequest{Token: "tokA", Target: "  "}); err == nil {
		t.Fatal("an empty target is refused")
	}
	if _, err := m.Settle(ctx, SettleRequest{Token: "nope", Target: "Julien"}); err == nil || err.Error() != errNotInMoltenTerm {
		t.Fatalf("bad token: %v", err)
	}
}

func TestSettleByTicketWithNothingWaitingSaysSo(t *testing.T) {
	m, env := stopsFixture(t, map[string]string{})
	if _, err := m.Settle(context.Background(), SettleRequest{Token: "tokA", Target: "1872"}); err == nil || !strings.Contains(err.Error(), "No agent on #1872") {
		t.Fatalf("no stop on the ticket: %v", err)
	}
	if _, err := m.Settle(context.Background(), SettleRequest{Token: "tokA", Target: "1999"}); err == nil || !strings.Contains(err.Error(), "No agent on #1999") {
		t.Fatalf("no agent on the ticket: %v", err)
	}
	env.stops = map[string]string{"blockJ": molten.AgentSettleOwnPrompt}
	if _, err := m.Settle(context.Background(), SettleRequest{Token: "tokA", Target: "1872"}); err == nil || !strings.Contains(err.Error(), "Julien is blocked on a prompt") {
		t.Fatalf("a prompt of its own: %v", err)
	}
}

func TestSettleFromAShellIsTheDevelopers(t *testing.T) {
	m, env := stopsFixture(t, map[string]string{})
	env.stops = map[string]string{"blockJ": molten.AgentSettleDone}
	res, err := m.Settle(context.Background(), SettleRequest{Token: "tokShell", Target: "Julien", Note: "ok"})
	if err != nil || res.By != "" || len(res.Settled) != 1 {
		t.Fatalf("a terminal without an agent settles as the developer: %+v %v", res, err)
	}
	if calls := env.settleCalls(); len(calls) != 1 || calls[0].by != "" {
		t.Fatalf("by: %+v", calls)
	}
}

// A reply delivered and submitted to the agent settles its stop; one only typed does not (the developer may still have
// to press Enter).
func TestAReplyDeliveredToTheAgentSettlesItsStop(t *testing.T) {
	m, env := stopsFixture(t, map[string]string{})
	answerWith(m, env, DecisionAlways)
	env.stops = map[string]string{"blockB": molten.AgentSettleDone}
	res, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "Carry on, the flake is #1874"}})
	if err != nil || res.Status != StatusDelivered {
		t.Fatalf("send: %+v %v", res, err)
	}
	calls := env.settleCalls()
	if len(calls) != 1 || calls[0] != (settleCall{"blockB", "Camille", "Carry on, the flake is #1874"}) {
		t.Fatalf("the reply settles the receiver's stop by its sender: %+v", calls)
	}
}

func TestATypedButNotSubmittedReplySettlesNothing(t *testing.T) {
	m, env := stopsFixture(t, map[string]string{})
	answerWith(m, env, DecisionAlways)
	env.typeOut = func(string) TypeResult { return TypeResult{Sent: true, Submitted: false} }
	res, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "Carry on"}})
	if err != nil || res.Status != StatusTyped {
		t.Fatalf("send: %+v %v", res, err)
	}
	if calls := env.settleCalls(); len(calls) != 0 {
		t.Fatalf("the prompt waits for Enter: %+v", calls)
	}
}

func TestSettleTargetParsing(t *testing.T) {
	cases := []struct {
		raw    string
		ticket int
		name   string
	}{
		{"1872", 1872, ""},
		{" #1872 ", 1872, ""},
		{"Julien", 0, "Julien"},
		{"#Julien", 0, "#Julien"},
		{"0", 0, "0"},
		{"", 0, ""},
	}
	for _, c := range cases {
		ticket, name := settleTarget(c.raw)
		if ticket != c.ticket || name != c.name {
			t.Errorf("settleTarget(%q) = %d, %q; want %d, %q", c.raw, ticket, name, c.ticket, c.name)
		}
	}
}

func TestTicketOfBranchDefaultNaming(t *testing.T) {
	for branch, want := range map[string]int{
		"feature/1872-flaky-backend": 1872,
		"fix/12":                     12,
		"rc-1.0.0":                   0,
		"develop":                    0,
		"feature/abc-1":              0,
		"":                           0,
	} {
		if got := ticketOfBranch("/p", branch); got != want {
			t.Errorf("ticketOfBranch(%q) = %d, want %d", branch, got, want)
		}
	}
}
