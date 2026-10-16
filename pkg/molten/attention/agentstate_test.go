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
	"github.com/wavetermdev/waveterm/pkg/molten/agentnames"
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
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("an agent that starts sits at its prompt until a signal, got %q", got)
	}
	h.states.input("b1", []byte("/clear\r"))
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("Enter alone is no sign of work (/clear ends no turn), got %q", got)
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
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("Enter answers: no longer waiting, but not known to work, got %q", got)
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
	h.states.names = agentnames.MakeAllocator([]string{"Jérôme"})
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
	if len(h.notices) != 1 || h.notices[0] != "warning:Jérôme is waiting for you" {
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
	if len(h.notices) != 2 || h.notices[1] != "success:Jérôme is done" {
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

// FR-SHELL-040-AC5: the hooks the launcher added to a run do not mark the agent as hooked by the user, so the hook
// setup offer comes back once the integration is off.
func TestIntegratedRunHooksAreNotTheUsers(t *testing.T) {
	h := makeAgentHarness()
	var remembered []string
	h.states.onHooked = func(agent string) { remembered = append(remembered, agent) }
	h.states.integratedRun = func(blockId string, run agentRunRecord) bool { return blockId == "b1" && run.agent == "claude" }
	h.out("b1", cmdMark("claude"))
	h.out("b2", cmdMark("claude"))
	h.states.flush()
	if err := h.report("b1", molten.AgentStateWorking, "claude"); err != nil {
		t.Fatal(err)
	}
	if h.states.isAgentHooked("claude") || len(remembered) != 0 {
		t.Fatalf("an integrated run's hooks are not remembered: %v", remembered)
	}
	if err := h.report("b2", molten.AgentStateWorking, "claude"); err != nil {
		t.Fatal(err)
	}
	if !h.states.isAgentHooked("claude") || strings.Join(remembered, ",") != "claude" {
		t.Fatalf("the user's own hooks are remembered: %v", remembered)
	}
}

func TestHookedAgentRepublishesItsTerminals(t *testing.T) {
	h := makeAgentHarness()
	var remembered []string
	h.states.onHooked = func(agent string) { remembered = append(remembered, agent) }
	h.out("b1", cmdMark("claude"))
	h.out("b2", cmdMark("claude"))
	h.out("b3", cmdMark("codex"))
	h.states.flush()
	for _, info := range h.states.snapshot() {
		if info.Hooked {
			t.Fatalf("no hook reported yet: %+v", info)
		}
	}
	h.published = nil
	if err := h.report("b1", molten.AgentStateWorking, "claude"); err != nil {
		t.Fatal(err)
	}
	h.states.flush()
	hooked := map[string]bool{}
	for _, info := range h.published {
		hooked[info.BlockId] = info.Hooked
	}
	if len(h.published) != 2 || !hooked["b1"] || !hooked["b2"] {
		t.Fatalf("both Claude Code terminals are published as hooked, Codex's is not: %+v", h.published)
	}
	h.report("b2", molten.AgentStateDone, "claude")
	if strings.Join(remembered, ",") != "claude" {
		t.Fatalf("the first report of an agent is remembered once: %v", remembered)
	}
	if !h.states.isAgentHooked("claude") || h.states.isAgentHooked("codex") {
		t.Fatalf("only Claude Code is hooked")
	}
	h.out("b4", cmdMark("claude"))
	h.states.flush()
	last := h.published[len(h.published)-1]
	if last.BlockId != "b4" || !last.Hooked {
		t.Fatalf("a new Claude Code terminal starts hooked: %+v", last)
	}
}

// The window translates the waiting and done titles from their code and the agent's name (#727).
func TestAgentNoticeTitleCodes(t *testing.T) {
	h := makeAgentHarness()
	h.states.names = agentnames.MakeAllocator([]string{"Pauline"})
	h.out("b1", cmdMark("claude"))
	signal, _, err := h.states.report(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateWaiting})
	if err != nil || signal == nil {
		t.Fatalf("waiting: %v %v", signal, err)
	}
	if signal.TitleCode != molten.NotificationTitleAgentWaiting || signal.TitleName != "Pauline" {
		t.Fatalf("waiting signal %+v", signal)
	}
	if vars := notificationTitleVars(*signal); vars["name"] != "Pauline" {
		t.Fatalf("title vars %v", vars)
	}
	h.clock = h.clock.Add(10 * time.Second)
	signal, _, _ = h.states.report(molten.AgentStateRequest{BlockId: "b1", State: molten.AgentStateDone})
	if signal == nil || signal.TitleCode != molten.NotificationTitleAgentDone || signal.TitleName != "Pauline" {
		t.Fatalf("done signal %+v", signal)
	}
	if vars := notificationTitleVars(AttentionSignal{Title: "from the agent"}); vars != nil {
		t.Fatalf("a signal without a code has no vars: %v", vars)
	}
}

func (h *agentHarness) version(block string) int64 {
	for _, info := range h.states.snapshot() {
		if info.BlockId == block {
			return info.Version
		}
	}
	return 0
}

// #784: done means finished and not seen yet. The window's seen clears it to idle, for the version it saw only;
// waiting and error never clear by being looked at.
func TestSeenClearsDoneOnly(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	h.report("b1", molten.AgentStateWaiting, "claude")
	if h.states.seen("b1", h.version("b1")) || h.state("b1") != molten.AgentStateWaiting {
		t.Fatalf("waiting cleared by a look: %q", h.state("b1"))
	}
	h.report("b1", molten.AgentStateDone, "claude")
	seenAt := h.version("b1")
	h.states.setSettings("b1", "claude", molten.AgentSettings{Model: "opus"})
	if h.states.seen("b1", seenAt) || h.state("b1") != molten.AgentStateDone {
		t.Fatalf("an older version must not clear: %q", h.state("b1"))
	}
	if !h.states.seen("b1", h.version("b1")) || h.state("b1") != molten.AgentStateIdle {
		t.Fatalf("seen done: %q", h.state("b1"))
	}
	if h.states.seen("b1", h.version("b1")) {
		t.Fatal("seen twice changes nothing")
	}
	h.report("b1", molten.AgentStateError, "claude")
	if h.states.seen("b1", h.version("b1")) || h.state("b1") != molten.AgentStateError {
		t.Fatalf("error cleared by a look: %q", h.state("b1"))
	}
	if h.states.seen("nope", 1) {
		t.Fatal("a block without agent")
	}
}

// #784: Claude Code's idle reminder through the terminal (OSC 9) ends a working turn but never brings back a done the
// user has seen, nor turns a finished agent to waiting.
func TestIdleReminderSignal(t *testing.T) {
	h := makeAgentHarness()
	h.out("b1", cmdMark("claude"))
	h.report("b1", molten.AgentStateDone, "claude")
	h.out("b1", "\x1b]9;Claude is waiting for your input\x07")
	if got := h.state("b1"); got != molten.AgentStateDone {
		t.Fatalf("done stays done, got %q", got)
	}
	h.states.seen("b1", h.version("b1"))
	h.clock = h.clock.Add(time.Minute)
	h.out("b1", "\x1b]9;Claude is waiting for your input\x07")
	if got := h.state("b1"); got != molten.AgentStateIdle {
		t.Fatalf("seen stays seen, got %q", got)
	}
	h.report("b1", molten.AgentStateWorking, "claude")
	h.out("b1", "\x1b]777;notify;Claude Code;Claude is waiting for your input\x07")
	if got := h.state("b1"); got != molten.AgentStateDone {
		t.Fatalf("working then the reminder: done, got %q", got)
	}
}
