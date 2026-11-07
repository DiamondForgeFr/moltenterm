// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type fake struct {
	lock sync.Mutex

	found   *Found
	agent   string
	missing bool
	// typed answers, one per call; the last one repeats.
	answers []TypeOutcome
	typed   []string
	sleeps  int

	tabs      []string
	tabHidden []waveobj.MetaMapType
	closed    []string
	opened    []string
	openedMet []waveobj.MetaMapType
	openErr   error
	noBlock   bool
	folder    string

	// answer: what his transcript says last; unlinked: his transcript is not known.
	answer    *Answer
	unlinked  bool
	read      int
	readBlock string
	// byTurn: the answers of the turns held, by index; readIndexes: the index each read asked for.
	byTurn      map[int]Answer
	readIndexes []int
}

func (f *fake) env() Env {
	return Env{
		Find: func(context.Context) (Found, bool) {
			f.lock.Lock()
			defer f.lock.Unlock()
			if f.found == nil {
				return Found{}, false
			}
			return *f.found, true
		},
		Folder: func() (string, error) { return f.folder, nil },
		PickAgent: func(string) (string, string, bool) {
			if f.agent == "" {
				return "", "Codex", f.missing
			}
			return f.agent, "Claude Code", false
		},
		CommandLine: func(agent string) string { return agent },
		AgentTab: func(_ context.Context, workspaceId string, name string, meta waveobj.MetaMapType) (string, error) {
			f.tabs = append(f.tabs, workspaceId+"/"+name)
			f.tabHidden = append(f.tabHidden, meta)
			return "tab-1", nil
		},
		CloseTab: func(_ context.Context, tabId string) error {
			f.closed = append(f.closed, tabId)
			return nil
		},
		OpenTerminal: func(_ context.Context, tabId string, meta waveobj.MetaMapType, line string) (string, error) {
			f.opened = append(f.opened, tabId+":"+line)
			f.openedMet = append(f.openedMet, meta)
			if f.noBlock {
				return "", f.openErr
			}
			f.lock.Lock()
			f.found = &Found{BlockId: "block-1", TabId: tabId}
			f.lock.Unlock()
			return "block-1", f.openErr
		},
		Type: func(_ context.Context, blockId string, line string) TypeOutcome {
			f.typed = append(f.typed, blockId+":"+line)
			i := len(f.typed) - 1
			if i >= len(f.answers) {
				i = len(f.answers) - 1
			}
			return f.answers[i]
		},
		Sleep: func(context.Context, time.Duration) bool {
			f.sleeps++
			return true
		},
		ReadAnswer: func(blockId string, index int) (Answer, bool) {
			f.read++
			f.readBlock = blockId
			f.readIndexes = append(f.readIndexes, index)
			if f.unlinked {
				return Answer{}, false
			}
			if index > 0 {
				return f.byTurn[index], true
			}
			if f.answer == nil {
				return Answer{}, true
			}
			return *f.answer, true
		},
	}
}

func TestSayStartsHisSessionInAHiddenTabAndWaitsForThePrompt(t *testing.T) {
	f := &fake{agent: "claude", folder: "/data/brokk", answers: []TypeOutcome{{Retry: true}, {Retry: true}, {Sent: true}}}
	got := MakeService(f.env()).Say(context.Background(), Request{WorkspaceId: "ws-1", Name: "Brokk", Text: "  what waits?  "})
	if got.Status != StatusSent || !got.Started || got.BlockId != "block-1" || got.Agent != "claude" {
		t.Fatalf("got %+v, want the text sent to a session this call started", got)
	}
	if len(f.tabs) != 1 || f.tabs[0] != "ws-1/Brokk" || f.tabHidden[0][BlockMetaKey] != true {
		t.Errorf("the tab was %v with %v, want one tab of the workspace marked as his", f.tabs, f.tabHidden)
	}
	if len(f.opened) != 1 || f.opened[0] != "tab-1:claude" {
		t.Errorf("the terminal ran %v, want the agent started in the new tab", f.opened)
	}
	meta := f.openedMet[0]
	if meta[BlockMetaKey] != true || meta[waveobj.MetaKey_CmdCwd] != "/data/brokk" || meta[waveobj.MetaKey_View] != "term" {
		t.Errorf("the terminal's metadata was %v, want his marker, his folder and a term view", meta)
	}
	if len(f.typed) != 3 || f.typed[2] != "block-1:what waits?" || f.sleeps != 2 {
		t.Errorf("typed %v after %d waits, want the text typed on the third try", f.typed, f.sleeps)
	}
}

func TestSayReusesTheSessionThatRuns(t *testing.T) {
	f := &fake{agent: "claude", found: &Found{BlockId: "block-9", TabId: "tab-9"}, answers: []TypeOutcome{{Sent: true}}}
	got := MakeService(f.env()).Say(context.Background(), Request{WorkspaceId: "ws-1", Text: "hello"})
	if got.Status != StatusSent || got.Started || got.BlockId != "block-9" {
		t.Fatalf("got %+v, want the text sent to the existing session", got)
	}
	if len(f.tabs) != 0 || len(f.opened) != 0 {
		t.Errorf("a second session was made: tabs %v, terminals %v", f.tabs, f.opened)
	}
}

func TestSayToABusyAgentKeepsTheTextWithTheDeveloper(t *testing.T) {
	f := &fake{found: &Found{BlockId: "block-9"}, answers: []TypeOutcome{{Retry: true, Message: "working"}}}
	got := MakeService(f.env()).Say(context.Background(), Request{Text: "hello"})
	if got.Status != StatusBusy || got.Reason != ReasonNotReady {
		t.Fatalf("got %+v, want busy", got)
	}
	if len(f.typed) != 1 || f.sleeps != 0 {
		t.Errorf("a running agent was asked %d times with %d waits, want one try and no wait", len(f.typed), f.sleeps)
	}
}

func TestSayWaitsForTheAgentJustStartedToShowInItsTerminal(t *testing.T) {
	f := &fake{agent: "claude", answers: []TypeOutcome{{NoAgent: true}, {Retry: true}, {Sent: true}}}
	got := MakeService(f.env()).Say(context.Background(), Request{WorkspaceId: "ws-1", Text: "hello"})
	if got.Status != StatusSent || !got.Started || len(f.typed) != 3 {
		t.Fatalf("got %+v after %d tries, want the text sent once the agent showed", got, len(f.typed))
	}
}

func TestSayDoesNotWaitForAnAgentThatEnded(t *testing.T) {
	f := &fake{found: &Found{BlockId: "block-9"}, answers: []TypeOutcome{{NoAgent: true}}}
	got := MakeService(f.env()).Say(context.Background(), Request{Text: "hello"})
	if got.Status != StatusFailed || got.Reason != ReasonNoAgent {
		t.Fatalf("got %+v, want a failure saying no agent runs in his terminal", got)
	}
	if len(f.typed) != 1 || f.sleeps != 0 || len(f.closed) != 0 {
		t.Errorf("tried %d times, waited %d times, closed %v: want one try, no wait and his terminal left alone", len(f.typed), f.sleeps, f.closed)
	}
}

func TestSayGivesUpOnAFreshAgentThatNeverShowsItsPrompt(t *testing.T) {
	f := &fake{agent: "claude", answers: []TypeOutcome{{Retry: true}}}
	got := MakeService(f.env()).Say(context.Background(), Request{WorkspaceId: "ws-1", Text: "hello"})
	if got.Status != StatusBusy || !got.Started {
		t.Fatalf("got %+v, want busy once the session started", got)
	}
	if want := int(startWait/startPoll) + 1; len(f.typed) != want {
		t.Errorf("tried %d times, want %d", len(f.typed), want)
	}
}

func TestSayWithoutAnAgentStartsNothing(t *testing.T) {
	for _, missing := range []bool{false, true} {
		f := &fake{missing: missing}
		got := MakeService(f.env()).Say(context.Background(), Request{WorkspaceId: "ws-1", Text: "hello"})
		want := StatusNoAgent
		if missing {
			want = StatusMissing
		}
		if got.Status != want {
			t.Errorf("missing=%v: got %q, want %q", missing, got.Status, want)
		}
		if len(f.tabs) != 0 || len(f.typed) != 0 {
			t.Errorf("missing=%v: a tab %v or a line %v was made without an agent", missing, f.tabs, f.typed)
		}
	}
}

func TestSayTakesTheTabAwayWhenItsTerminalCouldNotBeMade(t *testing.T) {
	f := &fake{agent: "claude", noBlock: true, openErr: errors.New("no shell")}
	got := MakeService(f.env()).Say(context.Background(), Request{WorkspaceId: "ws-1", Text: "hello"})
	if got.Status != StatusFailed || got.Reason != ReasonTerminal {
		t.Fatalf("got %+v, want a failure of the terminal", got)
	}
	if len(f.closed) != 1 || f.closed[0] != "tab-1" {
		t.Errorf("closed %v, want the empty tab taken away", f.closed)
	}
}

func TestSayNeedsAWorkspaceToStartAndATextToSend(t *testing.T) {
	f := &fake{agent: "claude", answers: []TypeOutcome{{Sent: true}}}
	svc := MakeService(f.env())
	if got := svc.Say(context.Background(), Request{Text: "hello"}); got.Reason != ReasonNoSpace {
		t.Errorf("without a workspace got %+v, want %q", got, ReasonNoSpace)
	}
	if got := svc.Say(context.Background(), Request{WorkspaceId: "ws-1", Text: "   "}); got.Reason != ReasonNoText {
		t.Errorf("without text got %+v, want %q", got, ReasonNoText)
	}
	if len(f.tabs) != 0 || len(f.typed) != 0 {
		t.Errorf("something was made for a call that could not work: tabs %v, lines %v", f.tabs, f.typed)
	}
}

func TestSayToATerminalThatIsGone(t *testing.T) {
	f := &fake{found: &Found{BlockId: "block-9"}, answers: []TypeOutcome{{Gone: true}}}
	got := MakeService(f.env()).Say(context.Background(), Request{Text: "hello"})
	if got.Status != StatusFailed || got.Reason != ReasonGone {
		t.Fatalf("got %+v, want the failure of a closed terminal", got)
	}
}

func TestOnlyOneMessageIsOnItsWayAtATime(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	f := &fake{found: &Found{BlockId: "block-9"}}
	env := f.env()
	env.Type = func(context.Context, string, string) TypeOutcome {
		close(entered)
		<-release
		return TypeOutcome{Sent: true}
	}
	svc := MakeService(env)
	done := make(chan Result)
	go func() { done <- svc.Say(context.Background(), Request{Text: "first"}) }()
	<-entered
	second := svc.Say(context.Background(), Request{Text: "second"})
	close(release)
	first := <-done
	if second.Status != StatusBusy || second.Reason != ReasonInProgress {
		t.Errorf("the second message got %+v, want busy while the first is on its way", second)
	}
	if first.Status != StatusSent {
		t.Errorf("the first message got %+v, want it sent", first)
	}
}

// #2028: his session answered in its hidden tab and the panel never showed it. Reply brings the answer back.
func TestReplyBringsHisAnswerBackToThePanel(t *testing.T) {
	f := &fake{found: &Found{BlockId: "block-9", TabId: "tab-9", WorkspaceId: "ws-9"}}
	f.answer = &Answer{Index: 2, Rev: 3, At: 5000, Markdown: "Two agents run now."}
	got := MakeService(f.env()).Reply(context.Background(), ReplyRequest{After: 4000})
	if got.Status != ReplyAnswer || got.Markdown != "Two agents run now." || got.Index != 2 || got.Rev != 3 {
		t.Fatalf("got %+v, want his answer", got)
	}
	if got.BlockId != "block-9" || got.TabId != "tab-9" || got.WorkspaceId != "ws-9" {
		t.Errorf("got %+v, want where his terminal is, for the way out", got)
	}
	if f.read != 1 || f.readBlock != "block-9" {
		t.Errorf("read %d times on %q, want his block read once", f.read, f.readBlock)
	}
}

func TestReplyWaitsForAnAnswerNewerThanTheMessage(t *testing.T) {
	f := &fake{found: &Found{BlockId: "block-9"}}
	svc := MakeService(f.env())
	if got := svc.Reply(context.Background(), ReplyRequest{After: 4000}); got.Status != ReplyWaiting {
		t.Errorf("before any answer got %+v, want waiting", got)
	}
	f.answer = &Answer{Index: 1, At: 3000, Markdown: "an earlier answer"}
	if got := svc.Reply(context.Background(), ReplyRequest{After: 4000}); got.Status != ReplyWaiting || got.Markdown != "" {
		t.Errorf("with an answer older than the message got %+v, want waiting and no text", got)
	}
}

// #2033: a second message starts a newer turn, and the first answer is read by its turn, whatever came after it.
func TestReplyReadsTheAnswerOfATurnWhateverCameAfterIt(t *testing.T) {
	f := &fake{found: &Found{BlockId: "block-9"}}
	f.answer = &Answer{Index: 4, At: 9000, Markdown: "the answer to the second message"}
	f.byTurn = map[int]Answer{3: {Index: 3, Rev: 2, At: 5000, Markdown: "the answer to the first message"}}
	svc := MakeService(f.env())

	// The latest answer is the second one's, and after the first message it would pass for the first one's.
	if got := svc.Reply(context.Background(), ReplyRequest{After: 4000}); got.Markdown != "the answer to the second message" {
		t.Fatalf("got %+v, want the latest answer when no turn is asked for", got)
	}
	got := svc.Reply(context.Background(), ReplyRequest{After: 8000, Index: 3})
	if got.Status != ReplyAnswer || got.Markdown != "the answer to the first message" || got.Index != 3 {
		t.Fatalf("got %+v, want the first answer, though it is older than the second message", got)
	}
	if f.readIndexes[len(f.readIndexes)-1] != 3 {
		t.Errorf("read indexes %v, want the turn asked for", f.readIndexes)
	}
	if got := svc.Reply(context.Background(), ReplyRequest{Index: 1}); got.Status != ReplyWaiting || got.Markdown != "" {
		t.Errorf("got %+v, want waiting for a turn his transcript no longer holds", got)
	}
}

func TestReplySaysWhenHisAnswerCannotBeRead(t *testing.T) {
	f := &fake{found: &Found{BlockId: "block-9", TabId: "tab-9"}, unlinked: true}
	if got := MakeService(f.env()).Reply(context.Background(), ReplyRequest{}); got.Status != ReplyUnread || got.BlockId != "block-9" {
		t.Errorf("got %+v, want unread with his terminal, to open it", got)
	}
	none := &fake{}
	if got := MakeService(none.env()).Reply(context.Background(), ReplyRequest{}); got.Status != StatusNone {
		t.Errorf("without a session got %+v, want none", got)
	}
}

// #2028: typed while the agent just started was still drawing its prompt, the first message was lost, and the next
// ones were left in its prompt without Enter. A fresh agent gets its message once it takes it with Enter.
func TestSayWaitsUntilTheFreshAgentTakesTheMessageWithEnter(t *testing.T) {
	f := &fake{agent: "claude", answers: []TypeOutcome{{Sent: true}}}
	env := f.env()
	checks := 0
	env.Ready = func(blockId string) bool {
		checks++
		return checks >= 3
	}
	got := MakeService(env).Say(context.Background(), Request{WorkspaceId: "ws-1", Text: "hello"})
	if got.Status != StatusSent || !got.Started {
		t.Fatalf("got %+v, want sent", got)
	}
	if len(f.typed) != 1 || f.sleeps != 2 {
		t.Errorf("typed %v after %d waits, want one line typed once the agent was ready", f.typed, f.sleeps)
	}
}

func TestSayDoesNotWaitForReadinessOnASessionThatRuns(t *testing.T) {
	f := &fake{found: &Found{BlockId: "block-9"}, answers: []TypeOutcome{{Sent: true}}}
	env := f.env()
	env.Ready = func(string) bool { return false }
	got := MakeService(env).Say(context.Background(), Request{Text: "hello"})
	if got.Status != StatusSent || len(f.typed) != 1 || f.sleeps != 0 {
		t.Errorf("got %+v after %d waits, want the line typed at once", got, f.sleeps)
	}
}

func TestSayTellsALineLeftInHisPromptWithoutEnter(t *testing.T) {
	f := &fake{found: &Found{BlockId: "block-9", TabId: "tab-9"}, answers: []TypeOutcome{{Sent: true, Unsubmitted: true}}}
	got := MakeService(f.env()).Say(context.Background(), Request{Text: "hello"})
	if got.Status != StatusFailed || got.Reason != ReasonNotSubmitted || got.BlockId != "block-9" {
		t.Fatalf("got %+v, want a failure saying the message waits in his prompt, with his terminal", got)
	}
}

func TestSayTellsWhereHisTerminalIs(t *testing.T) {
	f := &fake{agent: "claude", answers: []TypeOutcome{{Sent: true}}}
	got := MakeService(f.env()).Say(context.Background(), Request{WorkspaceId: "ws-1", Text: "hello"})
	if got.WorkspaceId != "ws-1" || got.TabId != "tab-1" || got.BlockId != "block-1" {
		t.Errorf("got %+v, want the workspace, tab and block of the session it started", got)
	}
}

func TestSessionOnlyLooks(t *testing.T) {
	f := &fake{agent: "claude"}
	svc := MakeService(f.env())
	if got := svc.Session(context.Background()); got.Status != StatusNone {
		t.Errorf("without a session got %+v, want none", got)
	}
	f.found = &Found{BlockId: "block-9", TabId: "tab-9"}
	if got := svc.Session(context.Background()); got.Status != StatusReady || got.BlockId != "block-9" {
		t.Errorf("with a session got %+v, want ready on its block", got)
	}
	if len(f.tabs) != 0 || len(f.opened) != 0 {
		t.Errorf("looking made a tab %v or a terminal %v", f.tabs, f.opened)
	}
}
