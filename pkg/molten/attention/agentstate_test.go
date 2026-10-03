// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package attention

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

type agentHarness struct {
	states    *agentStates
	watcher   *attentionWatcher
	published []molten.AgentStateInfo
	notices   []string
	recorded  []AttentionSignal
	clock     time.Time
}

func makeAgentHarness() *agentHarness {
	h := &agentHarness{clock: time.Unix(1_000_000, 0)}
	h.states = makeAgentStates()
	h.states.now = func() time.Time { return h.clock }
	h.states.locate = func(blockId string) (string, string, error) { return "tab-" + blockId, "ws1", nil }
	h.states.publish = func(info molten.AgentStateInfo) { h.published = append(h.published, info) }
	h.states.notify = func(blockId string, signal AttentionSignal, kind string) {
		h.notices = append(h.notices, kind+":"+signal.Title)
	}
	h.watcher = makeAttentionWatcher(func(blockId string, signal AttentionSignal) {
		h.recorded = append(h.recorded, signal)
	})
	h.watcher.now = func() time.Time { return h.clock }
	h.watcher.agents = h.states
	return h
}

func (h *agentHarness) out(block string, data string) {
	h.watcher.handle(block, []byte(data))
}

func (h *agentHarness) state(block string) string {
	snap := h.states.snapshot()
	for _, info := range snap {
		if info.BlockId == block {
			return info.State
		}
	}
	return ""
}

func (h *agentHarness) report(block string, state string, agent string) error {
	signal, kind, err := h.states.report(molten.AgentStateRequest{BlockId: block, State: state, Agent: agent})
	if signal != nil {
		h.states.notify(block, *signal, kind)
	}
	return err
}

func cmdMark(cmd string) string {
	return fmt.Sprintf("\x1b]16162;C;{\"cmd64\":\"%s\"}\x07", base64.StdEncoding.EncodeToString([]byte(cmd)))
}

func doneMark(code int) string {
	return fmt.Sprintf("\x1b]16162;D;{\"exitcode\":%d}\x07", code)
}

const promptMark = "\x1b]16162;A\x07"

func TestParseShellMark(t *testing.T) {
	long := strings.Repeat("x", 6000)
	enc := base64.StdEncoding.EncodeToString([]byte("claude " + long))
	mark, ok := ParseShellMark("16162;C;{\"cmd64\":\"" + enc[:3000])
	if !ok || !strings.HasPrefix(mark.Cmd, "claude xxx") {
		t.Errorf("a cut command line keeps its start: %+v %v", mark, ok)
	}
	mark, ok = ParseShellMark("16162;D;{\"exitcode\":2}")
	if !ok || mark.ExitCode == nil || *mark.ExitCode != 2 {
		t.Errorf("exit code: %+v", mark)
	}
	if _, ok := ParseShellMark("9;hello"); ok {
		t.Errorf("OSC 9 is no shell mark")
	}
}

func TestAgentLifecycleWithoutSignals(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude")+"Welcome to Claude Code")
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("state after start %q", got)
	}
	h.out("b1", doneMark(0)+promptMark)
	if got := h.state("b1"); got != "" {
		t.Fatalf("a clean exit forgets the agent, got %q", got)
	}
	h.out("b1", cmdMark("ls -la")+doneMark(0))
	if got := h.state("b1"); got != "" {
		t.Fatalf("a plain command is no agent, got %q", got)
	}
}

func TestAgentErrorStaysUntilNextCommand(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("codex"))
	h.out("b1", doneMark(1)+promptMark)
	if got := h.state("b1"); got != molten.AgentStateError {
		t.Fatalf("state after a failure %q", got)
	}
	h.out("b1", "\x07")
	if got := h.state("b1"); got != molten.AgentStateError {
		t.Fatalf("a bell after the exit changes nothing, got %q", got)
	}
	h.out("b1", cmdMark("ls"))
	if got := h.state("b1"); got != "" {
		t.Fatalf("the next command clears the error, got %q", got)
	}
	h.out("b1", cmdMark("codex")+doneMark(130))
	if got := h.state("b1"); got != "" {
		t.Fatalf("Ctrl-C is no error, got %q", got)
	}
}

func TestAgentSignalsAndInput(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	h.out("b1", "\x1b]9;Claude needs your permission to use Bash\x07")
	if got := h.state("b1"); got != molten.AgentStateWaiting {
		t.Fatalf("OSC 9 makes it wait, got %q", got)
	}
	if len(h.recorded) != 1 {
		t.Fatalf("the signal keeps its notification: %v", h.recorded)
	}
	h.states.input("b1", []byte("y"))
	if got := h.state("b1"); got != molten.AgentStateWaiting {
		t.Fatalf("a key without Enter changes nothing, got %q", got)
	}
	h.states.input("b1", []byte("\r"))
	if got := h.state("b1"); got != molten.AgentStateWorking {
		t.Fatalf("Enter answers, got %q", got)
	}
	// The same signal again within the dedup window: no second notification, but the state follows.
	h.out("b1", "\x1b]9;Claude needs your permission to use Bash\x07")
	if got := h.state("b1"); got != molten.AgentStateWaiting || len(h.recorded) != 1 {
		t.Fatalf("repeat: state %q, recorded %d", got, len(h.recorded))
	}
	h.out("b1", "\x1b]777;notify;Codex;Turn complete\x07")
	if got := h.state("b1"); got != molten.AgentStateDone {
		t.Fatalf("a completed turn is done, got %q", got)
	}
	h.out("b2", "\x07")
	if got := h.state("b2"); got != "" || len(h.recorded) != 3 {
		t.Fatalf("a bell without agent stays a plain notification: %q %d", got, len(h.recorded))
	}
}

func TestSignalAndCommandInOneChunk(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("gemini")+"thinking\x07"+doneMark(0)+promptMark)
	if got := h.state("b1"); got != "" {
		t.Fatalf("the items apply in output order, got %q", got)
	}
	h.out("b1", cmdMark("gemini")+"thinking\x07")
	if got := h.state("b1"); got != molten.AgentStateWaiting {
		t.Fatalf("got %q", got)
	}
}

func TestHookReportsAndNoDoubleNotification(t *testing.T) {
	h := makeAgentHarness()
	if err := h.report("b1", molten.AgentStateWaiting, ""); err == nil {
		t.Fatalf("a report without a known agent needs --agent")
	}
	if err := h.report("b1", "busy", "claude"); err == nil {
		t.Fatalf("an unknown state is refused")
	}
	h.out("b1", cmdMark("claude"))
	if err := h.report("b1", molten.AgentStateWaiting, ""); err != nil {
		t.Fatal(err)
	}
	if len(h.notices) != 1 || h.notices[0] != "warning:Claude Code is waiting for you" {
		t.Fatalf("notices %v", h.notices)
	}
	// Claude Code's own OSC 9 for the same moment.
	h.out("b1", "\x1b]9;Claude needs your permission\x07")
	if len(h.recorded) != 0 {
		t.Fatalf("the OSC signal right after the hook must not notify again: %v", h.recorded)
	}
	h.report("b1", molten.AgentStateWaiting, "")
	if len(h.notices) != 1 {
		t.Fatalf("the same state twice notifies once: %v", h.notices)
	}
	h.report("b1", molten.AgentStateWorking, "")
	h.clock = h.clock.Add(10 * time.Second)
	h.report("b1", molten.AgentStateDone, "")
	if len(h.notices) != 2 || h.notices[1] != "success:Claude Code is done" {
		t.Fatalf("notices %v", h.notices)
	}
	// The other way round: the signal first, then the hook.
	h.clock = h.clock.Add(10 * time.Second)
	h.report("b1", molten.AgentStateWorking, "")
	h.out("b1", "\x1b]9;Claude is waiting for your input\x07")
	h.report("b1", molten.AgentStateWaiting, "")
	if len(h.recorded) != 1 || len(h.notices) != 2 {
		t.Fatalf("signal then hook: recorded %d notices %v", len(h.recorded), h.notices)
	}
	if err := h.report("b9", molten.AgentStateDone, "my-agent"); err != nil || h.state("b9") != molten.AgentStateDone {
		t.Fatalf("a hook can name an agent the registry does not know: %v", err)
	}
}

func TestPublisherCoalescesAndLocates(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude")+"\x07")
	h.states.flush()
	if len(h.published) != 1 {
		t.Fatalf("two changes before a pass publish once: %+v", h.published)
	}
	info := h.published[0]
	if info.State != molten.AgentStateWaiting || info.TabId != "tab-b1" || info.WorkspaceId != "ws1" || info.AgentName != "Claude Code" {
		t.Fatalf("published %+v", info)
	}
	h.states.forget("b1")
	h.states.flush()
	last := h.published[len(h.published)-1]
	if !last.Cleared || last.Version <= info.Version {
		t.Fatalf("a closed block is published as cleared, with a newer version: %+v", last)
	}
	h.states.flush()
	if len(h.published) != 2 {
		t.Fatalf("nothing changed, nothing published: %d", len(h.published))
	}
	h.out("b2", cmdMark("opencode"))
	h.states.flush()
	if snap := h.states.snapshot(); len(snap) != 1 || snap[0].WorkspaceId != "ws1" {
		t.Fatalf("the snapshot carries the location: %+v", snap)
	}
}
