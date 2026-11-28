// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package attention

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #2583 (FR-CONT-015): a service the agent left running in the background (a dev server, a daemon) runs until it is
// stopped, so the agent never resumes on it: it is not work. The pane shows the agent's own state, raises its notice and
// lists the service.

// bgHookToolCommand is the PostToolUse of a Bash call left in the background, with the command line it ran.
func bgHookToolCommand(transcript string, id string, description string, command string) string {
	return fmt.Sprintf(`{"session_id":"s","transcript_path":%q,"cwd":"/w","permission_mode":"bypassPermissions","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":%q,"description":%q,"run_in_background":true},"tool_response":{"stdout":"","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false,"backgroundTaskId":%q},"tool_use_id":"toolu_01"}`, transcript, command, description, id)
}

const (
	browserDaemonCommand = "node ~/skills/molten-browser/scripts/molten-browser.mjs daemon"
	devServerCommand     = "cd app && npm run dev"
)

// wantServicesOnly: the pane shows its own state, no background, no work: only the services it published.
func wantServicesOnly(t *testing.T, h *agentHarness, block string, state string, services []string) molten.AgentStateInfo {
	t.Helper()
	info := h.info(block)
	if info.State != state || info.Background || info.MessageText != nil || info.Message != "" || info.Subagents != 0 {
		t.Fatalf("published %+v (text %+v), want %s with no background work", info, info.MessageText, state)
	}
	if !reflect.DeepEqual(info.Services, services) {
		t.Fatalf("services %q, want %q", info.Services, services)
	}
	return info
}

// A turn that ends with only a service left is done, not working in the background, and calls the developer as any
// turn end does.
func TestServiceAloneDoesNotKeepThePaneWorking(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	h.out("b1", cmdMark("claude"))
	h.hookNotify(t, "b1", hookMainPrompt, bgHookToolCommand(tr, "bz4ehrk6q", "Molten browser daemon", browserDaemonCommand), bgHookStop(tr))
	if run, _ := h.states.runOf("b1"); run.State != molten.AgentStateDone {
		t.Fatalf("the main session's own state is its Stop: %+v", run)
	}
	wantServicesOnly(t, h, "b1", molten.AgentStateDone, []string{"Molten browser daemon"})
	if len(h.notices) != 1 || !strings.HasPrefix(h.notices[0], "success:") {
		t.Fatalf("the turn end calls the developer: %v", h.notices)
	}

	// The terminal's own "done" signal is not held by a service either.
	if h.states.backgroundDoneSignal("b1", AttentionSignal{Title: "Claude is done"}) {
		t.Fatalf("a service holds no done signal")
	}

	// The turn that follows is work as any turn: the service is only listed.
	h.hookNotify(t, "b1", hookMainPrompt)
	info := h.info("b1")
	if info.State != molten.AgentStateWorking || info.Background || !reflect.DeepEqual(info.Services, []string{"Molten browser daemon"}) {
		t.Fatalf("a turn in progress works, and the service shows in the tree: %+v", info)
	}
}

// A service with no words is still counted, and an agent that gave none names it by its count.
func TestServiceWithoutWordsIsCounted(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	h.hookNotify(t, "b1", hookMainPrompt, bgHookToolCommand(tr, "bz4ehrk6q", "", "tail -f build.log"), bgHookStop(tr))
	wantServicesOnly(t, h, "b1", molten.AgentStateDone, []string{""})
}

// Two services: one count, and no working state, in the order they started.
func TestTwoServicesAreListedAndNeitherIsWork(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	h.hookNotify(t, "b1", hookMainPrompt,
		bgHookToolCommand(tr, "b2second0", "Dev server", devServerCommand),
		bgHookToolCommand(tr, "b1first000", "Molten browser daemon", browserDaemonCommand),
		bgHookStop(tr))
	wantServicesOnly(t, h, "b1", molten.AgentStateDone, []string{"Dev server", "Molten browser daemon"})
	if len(h.notices) != 1 {
		t.Fatalf("notices %v", h.notices)
	}
}

// A bounded command and a service: the agent works in the background on the bounded one, named alone. When it ends the
// agent resumes and its turn end calls the developer; the service stays.
func TestBoundedCommandWithAServiceKeepsTheWorkAndListsTheService(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	h.hookNotify(t, "b1", hookMainPrompt,
		bgHookToolCommand(tr, "b1service0", "Molten browser daemon", browserDaemonCommand),
		bgHookTool(tr, "bz4ehrk6q", "Wait for the CI"),
		bgHookStop(tr))
	info := wantBackground(t, h, "b1", "agentState.backgroundCommandNamed")
	if info.MessageText.Vars["description"] != "Wait for the CI" || info.Message != "In the background: Wait for the CI" {
		t.Fatalf("the message names the bounded command only: %+v %q", info.MessageText, info.Message)
	}
	if !reflect.DeepEqual(info.Services, []string{"Molten browser daemon"}) {
		t.Fatalf("services %q", info.Services)
	}
	if len(h.notices) != 0 {
		t.Fatalf("the bounded command holds the turn end: %v", h.notices)
	}

	// Two bounded commands count as two, the service not among them.
	h2 := makeAgentHarness()
	tr2 := makeTranscript(t)
	h2.hookNotify(t, "b2", hookMainPrompt,
		bgHookToolCommand(tr2, "b2service0", "Dev server", devServerCommand),
		bgHookTool(tr2, "b2aaaaaaa", "Wait for the CI"), bgHookTool(tr2, "b2bbbbbbb", "Wait for the build"),
		bgHookStop(tr2))
	info = wantBackground(t, h2, "b2", "agentState.backgroundCommands")
	if info.MessageText.Vars["count"] != "2" {
		t.Fatalf("count %+v", info.MessageText)
	}

	// The bounded command ends: the pane is released and calls the developer, the service remains.
	appendTranscript(t, tr, bgNotificationRecords("bz4ehrk6q", "completed"))
	h.hookNotify(t, "b1", bgHookPlainTool(tr), bgHookStop(tr))
	wantServicesOnly(t, h, "b1", molten.AgentStateDone, []string{"Molten browser daemon"})
	if len(h.notices) != 1 || !strings.HasPrefix(h.notices[0], "success:") {
		t.Fatalf("the resumed turn's end calls the developer: %v", h.notices)
	}
}

// The end of a service releases nothing: it never held the turn, so no notice comes of it.
func TestServiceEndRaisesNoNotice(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	h.hookNotify(t, "b1", hookMainPrompt, bgHookToolCommand(tr, "bz4ehrk6q", "Molten browser daemon", browserDaemonCommand), bgHookStop(tr))
	if len(h.notices) != 1 {
		t.Fatalf("the turn end called the developer once: %v", h.notices)
	}
	appendTranscript(t, tr, bgNotificationRecords("bz4ehrk6q", "killed"))
	h.hookNotify(t, "b1", bgHookStop(tr))
	wantServicesOnly(t, h, "b1", molten.AgentStateDone, nil)
	if len(h.notices) != 1 {
		t.Fatalf("a service that ends calls nobody: %v", h.notices)
	}
}

// #2582: a service the agent stops with TaskStop is gone at the turn end that follows.
func TestServiceStoppedWithTaskStop(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	h.hookNotify(t, "b1", hookMainPrompt, bgHookToolCommand(tr, "bz4ehrk6q", "Dev server", devServerCommand), bgHookStop(tr))
	wantServicesOnly(t, h, "b1", molten.AgentStateDone, []string{"Dev server"})

	h.hookNotify(t, "b1", hookMainPrompt)
	appendTranscript(t, tr, bgTaskStopRecords("bz4ehrk6q", "npm run dev"))
	h.hookNotify(t, "b1", bgHookTaskStop(tr, "bz4ehrk6q", "npm run dev"), bgHookStop(tr))
	wantServicesOnly(t, h, "b1", molten.AgentStateDone, nil)
}

// A session start forgets the services, as it forgets every command.
func TestSessionStartForgetsTheServices(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	h.hookNotify(t, "b1", hookMainPrompt, bgHookToolCommand(tr, "bz4ehrk6q", "Dev server", devServerCommand), bgHookStop(tr))
	wantServicesOnly(t, h, "b1", molten.AgentStateDone, []string{"Dev server"})
	h.hookNotify(t, "b1", hookSessionStart)
	wantServicesOnly(t, h, "b1", molten.AgentStateIdle, nil)
}

// The run's end forgets them too, and the set is bounded like the other commands.
func TestServicesAreBoundedAndForgottenWithTheRun(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	for i := 0; i < maxTrackedSubagents+10; i++ {
		h.send(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateWorking, Agent: "claude", BackgroundTask: fmt.Sprintf("b%08d", i), BackgroundService: true, BackgroundDescription: fmt.Sprintf("Server %d", i), Transcript: tr})
	}
	h.send(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateDone, Agent: "claude", Transcript: tr})
	info := h.info("b1")
	if len(info.Services) != maxServicesShown || info.Services[0] != "Server 0" || info.Services[1] != "Server 1" || info.State != molten.AgentStateDone {
		t.Fatalf("bounded, in the order they started: %q %s", info.Services, info.State)
	}
	h.states.forget("b1")
	if info := h.info("b1"); info.State != "" || info.Services != nil {
		t.Fatalf("the run's end forgets its services: %+v", info)
	}
}

// Sub-agents at work still make the pane work in the background, and the services stay listed beside them.
func TestServicesBesideSubagentsAtWork(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	h.hookNotify(t, "b1", hookMainPrompt, bgHookToolCommand(tr, "bz4ehrk6q", "Dev server", devServerCommand), bgHookStop(tr), hookSubStart, hookSubTool)
	info := wantBackground(t, h, "b1", "agentState.subagent")
	if info.Subagents != 1 || !reflect.DeepEqual(info.Services, []string{"Dev server"}) {
		t.Fatalf("%+v", info)
	}
}

// An agent with no hooks reports no service: the old requests, without the flag, keep working as bounded work.
func TestACommandWithoutTheServiceFlagIsBounded(t *testing.T) {
	t.Parallel()
	h := makeAgentHarness()
	tr := makeTranscript(t)
	h.send(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateWorking, Agent: "claude", BackgroundTask: "bz4ehrk6q", BackgroundDescription: "Dev server", Transcript: tr})
	h.send(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateDone, Agent: "claude", Transcript: tr})
	info := wantBackground(t, h, "b1", "agentState.backgroundCommandNamed")
	if info.Services != nil {
		t.Fatalf("services %q", info.Services)
	}
}
