// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brokksession

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeTalk is his session as the talk sees it, with no agent behind it: what a lookup and each message answer, the
// readings of his answer, his agent's state, and the waits of the follow and of the queue, which the test releases one
// at a time.
type fakeTalk struct {
	lock     sync.Mutex
	found    Result
	says     []Result
	said     []Request
	reply    func(req ReplyRequest) (Reply, bool)
	reads    []ReplyRequest
	facts     TalkFacts
	factsRead int
	pending   *PermissionAsk
	answered []PermitRequest
	revs     int
	follows  chan struct{}
	queues   chan struct{}
}

func makeFakeTalk() *fakeTalk {
	return &fakeTalk{
		found:   Result{Status: StatusReady, BlockId: "block-9", TabId: "tab-9", WorkspaceId: "ws-9"},
		says:    []Result{{Status: StatusSent, BlockId: "block-9", TabId: "tab-9", WorkspaceId: "ws-9"}},
		reply:   func(ReplyRequest) (Reply, bool) { return Reply{Status: ReplyWaiting}, true },
		follows: make(chan struct{}),
		queues:  make(chan struct{}),
	}
}

func (f *fakeTalk) talk() *Talk {
	return MakeTalk(TalkEnv{
		Lookup: func(context.Context) Result {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.found
		},
		Say: func(_ context.Context, req Request) Result {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.said = append(f.said, req)
			rtn := f.says[0]
			if len(f.says) > 1 {
				f.says = f.says[1:]
			}
			return rtn
		},
		Reply: func(_ context.Context, req ReplyRequest) (Reply, bool) {
			f.lock.Lock()
			f.reads = append(f.reads, req)
			read := f.reply
			f.lock.Unlock()
			return read(req)
		},
		Facts: func(string) TalkFacts {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.factsRead++
			return f.facts
		},
		Pending: func() *PermissionAsk {
			f.lock.Lock()
			defer f.lock.Unlock()
			return f.pending
		},
		Answer: func(req PermitRequest) PermitResult {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.answered = append(f.answered, req)
			f.pending = nil
			return PermitResult{Status: PermitAnswered}
		},
		Wait: func(d time.Duration) {
			if d == QueueEvery {
				<-f.queues
				return
			}
			<-f.follows
		},
		Publish: func(int64) {
			f.lock.Lock()
			defer f.lock.Unlock()
			f.revs++
		},
		Instance: "test",
	})
}

func (f *fakeTalk) set(fn func()) {
	f.lock.Lock()
	defer f.lock.Unlock()
	fn()
}

// reading lets the follow read his answer once more.
func (f *fakeTalk) reading(t *testing.T) {
	t.Helper()
	select {
	case f.follows <- struct{}{}:
	case <-time.After(time.Minute):
		t.Fatal("nothing follows his answer")
	}
}

// retry lets a waiting message be tried once more.
func (f *fakeTalk) retry(t *testing.T) {
	t.Helper()
	select {
	case f.queues <- struct{}{}:
	case <-time.After(time.Minute):
		t.Fatal("no message waits for him")
	}
}

func (f *fakeTalk) sayCount() int {
	f.lock.Lock()
	defer f.lock.Unlock()
	return len(f.said)
}

func (f *fakeTalk) firstSaid() Request {
	f.lock.Lock()
	defer f.lock.Unlock()
	return f.said[0]
}

func (f *fakeTalk) readAt(i int) ReplyRequest {
	f.lock.Lock()
	defer f.lock.Unlock()
	if i < 0 {
		i = len(f.reads) + i
	}
	return f.reads[i]
}

func (f *fakeTalk) factsReadings() int {
	f.lock.Lock()
	defer f.lock.Unlock()
	return f.factsRead
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("never: %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func shape(entries []TalkEntry) string {
	parts := make([]string, len(entries))
	for i, e := range entries {
		text := e.Text
		if e.Role == RoleBrokk {
			text = e.Markdown
		}
		parts[i] = e.Role + ":" + text
	}
	return strings.Join(parts, " | ")
}

func phaseIs(talk *Talk, phase string) func() bool {
	return func() bool { return talk.View().State.Phase == phase }
}

// #2382 (AC99): there is one Brokk. A message sent from one window shows, with its answer, in every window, and so do
// the state of the message and the question his agent waits on; a question answered in one window is gone from all.
func TestOneConversationForEveryWindow(t *testing.T) {
	t.Parallel()
	f := makeFakeTalk()
	talk := f.talk()
	state := talk.Say(TalkSayRequest{Text: "  which projects use the toolkit?  ", WorkspaceId: "ws-a", Name: "Brokk", Origin: "tab-a"})
	if state.Phase != PhaseAnswering {
		t.Fatalf("state %+v", state)
	}
	if said := f.firstSaid(); said.WorkspaceId != "ws-a" || said.Name != "Brokk" || said.Text != "which projects use the toolkit?" {
		t.Fatalf("said %+v", said)
	}
	// Window B reads the talk: the same message, the same state, the same face.
	seen := talk.View()
	if shape(seen.Main) != "you:which projects use the toolkit?" || seen.State.Phase != PhaseAnswering || seen.Main[0].Origin != "tab-a" || !seen.Main[0].Taken {
		t.Fatalf("window B sees %+v", seen)
	}
	ask := &PermissionAsk{Id: "q-1", BlockId: "block-9", Kind: PermitKindQuestion, Subject: "Where?", Questions: []AgentQuestion{{Question: "Where?", Options: []AgentChoice{{Label: "Documents"}}}}}
	f.set(func() { f.pending = ask })
	talk.AsksChanged()
	f.reading(t)
	eventually(t, "his question is a wait for the developer, answered in the window", phaseIs(talk, PhaseNeedsAnswer))
	if got := talk.View().Permission; got == nil || got.Id != "q-1" || got.Questions[0].Options[0].Label != "Documents" {
		t.Fatalf("window B shows the question %+v", got)
	}
	if status := talk.Permit(PermitRequest{Id: "q-1", BlockId: "block-9", Decision: PermitAnswer, Answers: map[string]string{"Where?": "Documents"}}); status.Status != PermitAnswered {
		t.Fatalf("answer %+v", status)
	}
	if v := talk.View(); v.Permission != nil || v.PermissionGone {
		t.Fatalf("a question answered in window A is still asked: %+v", v)
	}
	f.set(func() {
		f.reply = func(ReplyRequest) (Reply, bool) {
			return Reply{Status: ReplyAnswer, Index: 4, At: 20, Markdown: "Two projects use it."}, true
		}
	})
	f.reading(t)
	eventually(t, "his answer comes in", func() bool { return len(talk.View().Main) == 2 })
	f.reading(t)
	eventually(t, "his answer is complete", phaseIs(talk, PhaseAnswered))
	view := talk.View()
	if shape(view.Main) != "you:which projects use the toolkit? | brokk:Two projects use it." || !view.Main[1].Final || view.Main[1].Turn != 4 {
		t.Fatalf("window B sees %+v", view.Main)
	}
	if view.Main[1].Id != view.Main[0].Id || view.Main[1].Origin != "tab-a" {
		t.Fatalf("his answer is not tied to its message: %+v", view.Main)
	}
	if view.BlockId != "block-9" || view.Instance != "test" || view.Rev == 0 {
		t.Fatalf("view %+v", view)
	}
}

// #2028, #2155: his answer is read until his agent is done; a wait on a prompt is said, and his answer is read once he
// goes on; an answer that cannot be read says where it is.
func TestTheFollowOfHisAnswer(t *testing.T) {
	t.Parallel()
	f := makeFakeTalk()
	talk := f.talk()
	f.set(func() { f.facts = TalkFacts{Waiting: true} })
	before := time.Now().UnixMilli()
	talk.Say(TalkSayRequest{Text: "clean the old branches", Origin: "tab-a"})
	f.reading(t)
	eventually(t, "his wait is said", phaseIs(talk, PhaseNeedsAnswer))
	if where := talk.View().State.Where; where == nil || where.BlockId != "block-9" || where.TabId != "tab-9" {
		t.Fatalf("where %+v", where)
	}
	if after := f.readAt(0).After; after > before || after < before-60000 {
		t.Fatalf("read after %d, the message was sent at %d", after, before)
	}
	f.set(func() {
		f.facts = TalkFacts{Working: true}
		f.reply = func(ReplyRequest) (Reply, bool) { return Reply{Status: ReplyAnswer, Index: 2, Markdown: "Done."}, true }
	})
	f.reading(t)
	eventually(t, "he goes on", phaseIs(talk, PhaseAnswering))
	f.set(func() { f.facts = TalkFacts{} })
	f.reading(t)
	f.reading(t)
	eventually(t, "his answer is here", phaseIs(talk, PhaseAnswered))
	if got := talk.View().State.Reply; got != "Done." {
		t.Fatalf("reply %q", got)
	}
	if last := f.readAt(-1); last.Index != 2 {
		t.Fatalf("once its turn is known, the answer is read by it: %+v", last)
	}

	g := makeFakeTalk()
	other := g.talk()
	g.set(func() {
		g.reply = func(ReplyRequest) (Reply, bool) {
			return Reply{Status: ReplyUnread, BlockId: "block-9", TabId: "tab-9", WorkspaceId: "ws-9"}, true
		}
		g.facts = TalkFacts{Working: true}
	})
	other.Say(TalkSayRequest{Text: "hello"})
	g.reading(t)
	eventually(t, "the first reading saw his agent at work", func() bool { return g.factsReadings() >= 1 })
	g.set(func() { g.facts = TalkFacts{} })
	for i := 0; i < IdleReadingsForUnread; i++ {
		g.reading(t)
	}
	eventually(t, "his unreadable answer is said", phaseIs(other, PhaseUnread))
}

// #2257, #2284: a message his agent cannot take now waits, goes by itself once his prompt is free, takes the messages
// sent meanwhile with it, and a Cancel gives its text back to the field.
func TestAMessageWaitsForHim(t *testing.T) {
	t.Parallel()
	f := makeFakeTalk()
	talk := f.talk()
	f.set(func() {
		f.says = []Result{{Status: StatusBusy, Reason: ReasonInProgress}, {Status: StatusSent, BlockId: "block-9", TabId: "tab-9"}}
		f.facts = TalkFacts{PromptBusy: true}
	})
	if state := talk.Say(TalkSayRequest{Text: "first", Origin: "tab-a"}); state.Phase != PhaseQueued {
		t.Fatalf("state %+v", state)
	}
	talk.Say(TalkSayRequest{Text: "second", Origin: "tab-b"})
	view := talk.View()
	if len(view.Waiting) != 1 || view.Waiting[0].Text != "first\n\nsecond" || len(view.Main) != 0 {
		t.Fatalf("waiting %+v, exchange %+v", view.Waiting, view.Main)
	}
	// His turn runs: the wait has no limit, and nothing is typed.
	f.retry(t)
	f.retry(t)
	eventually(t, "both tries saw his prompt taken", func() bool { return f.factsReadings() >= 2 })
	if f.sayCount() != 1 {
		t.Fatalf("a message was tried while his prompt was taken: %d tries", f.sayCount())
	}
	f.set(func() { f.facts = TalkFacts{} })
	f.retry(t)
	eventually(t, "the waiting messages go", func() bool { return len(talk.View().Main) == 1 })
	view = talk.View()
	if shape(view.Main) != "you:first\n\nsecond" || len(view.Waiting) != 0 || view.State.Phase != PhaseAnswering {
		t.Fatalf("view %+v", view)
	}

	g := makeFakeTalk()
	other := g.talk()
	g.set(func() { g.says = []Result{{Status: StatusBusy, Reason: ReasonInProgress}} })
	other.Say(TalkSayRequest{Text: "never mind"})
	result, err := other.Op(TalkOpRequest{Op: TalkOpCancel})
	if err != nil || len(result.View.Waiting) != 0 || result.View.Returned[ConversationMain] != "never mind" || result.View.State.Phase != PhaseIdle {
		t.Fatalf("cancel %+v %v", result.View, err)
	}
	taken, _ := other.Op(TalkOpRequest{Op: TalkOpTake})
	if taken.Text != "never mind" || len(taken.View.Returned) != 0 {
		t.Fatalf("take %+v", taken)
	}
}

// #2033: a message his agent takes while his first answer comes in never loses it: the first answer is read to its
// end, by its turn, before the second is followed.
func TestTheFirstAnswerIsReadToItsEnd(t *testing.T) {
	t.Parallel()
	f := makeFakeTalk()
	talk := f.talk()
	f.set(func() {
		f.facts = TalkFacts{Working: true}
		f.reply = func(req ReplyRequest) (Reply, bool) {
			if req.Index == 3 {
				return Reply{Status: ReplyAnswer, Index: 3, Markdown: "One agent, the reviewer."}, true
			}
			return Reply{Status: ReplyAnswer, Index: 3, Markdown: "One agent"}, true
		}
	})
	talk.Say(TalkSayRequest{Text: "how many agents run?"})
	f.reading(t)
	eventually(t, "the first answer comes in", func() bool { return len(talk.View().Main) == 2 })
	f.set(func() {
		f.reply = func(req ReplyRequest) (Reply, bool) {
			if req.Index == 3 {
				return Reply{Status: ReplyAnswer, Index: 3, Markdown: "One agent, the reviewer."}, true
			}
			return Reply{Status: ReplyWaiting}, true
		}
	})
	talk.Say(TalkSayRequest{Text: "and builds?"})
	view := talk.View()
	if shape(view.Main) != "you:how many agents run? | brokk:One agent, the reviewer. | you:and builds?" || !view.Main[1].Final {
		t.Fatalf("exchange %+v", view.Main)
	}
}

// AC25: his answer is his line under the square while no window has the talk open; a window that opens takes it away,
// and an answer that comes in while a window is open is no news.
func TestHisLineIsForAnAnswerNobodySaw(t *testing.T) {
	t.Parallel()
	f := makeFakeTalk()
	talk := f.talk()
	f.set(func() {
		f.reply = func(ReplyRequest) (Reply, bool) { return Reply{Status: ReplyAnswer, Index: 1, Markdown: "Ready."}, true }
	})
	talk.Say(TalkSayRequest{Text: "status?"})
	f.reading(t)
	eventually(t, "his answer comes in", func() bool { return talk.View().Unseen != "" })
	opened, _ := talk.Op(TalkOpRequest{Op: TalkOpWindow, Origin: "tab-b", Open: true})
	if opened.View.Unseen != "" {
		t.Fatalf("a window looked, and his line stays: %+v", opened.View)
	}
	f.set(func() {
		f.reply = func(ReplyRequest) (Reply, bool) { return Reply{Status: ReplyAnswer, Index: 1, Markdown: "Ready, all green."}, true }
	})
	f.reading(t)
	eventually(t, "his answer goes on", func() bool { return strings.Contains(shape(talk.View().Main), "all green") })
	if talk.View().Unseen != "" {
		t.Fatal("an answer read while a window shows it became his line")
	}
}

// FR-BOSS-010 AC24, #2246, #2248, #2285: the brainstorm's conversation is apart from his ordinary one; the answer that
// opens it moves with it; its kept turns show again, offering nothing; a message still waiting from a brainstorm left
// comes back to the field.
func TestTheBrainstormHasItsOwnConversation(t *testing.T) {
	t.Parallel()
	f := makeFakeTalk()
	talk := f.talk()
	f.set(func() {
		f.facts = TalkFacts{Working: true}
		f.reply = func(ReplyRequest) (Reply, bool) { return Reply{Status: ReplyAnswer, Index: 1, Markdown: "Let's map it."}, true }
	})
	talk.Op(TalkOpRequest{Op: TalkOpLead, Text: "[brainstorm]"})
	talk.Say(TalkSayRequest{Text: "a video app for kids"})
	f.reading(t)
	eventually(t, "his answer comes in", func() bool { return len(talk.View().Main) == 2 })
	view := talk.View()
	if view.Lead != "" || view.Main[0].Text != "[brainstorm] a video app for kids" {
		t.Fatalf("the lead went with the message, once: %+v", view)
	}
	carry := view.Main[0].Id
	switched, _ := talk.Op(TalkOpRequest{Op: TalkOpSwitch, Conversation: ConversationBrainstorm, Carry: carry, Fresh: true})
	if switched.View.Conversation != ConversationBrainstorm || len(switched.View.Main) != 0 || len(switched.View.Brainstorm) != 2 {
		t.Fatalf("switch %+v", switched.View)
	}
	if got := switched.View.InFlight; len(got) != 1 || got[0] != ConversationBrainstorm {
		t.Fatalf("in flight %+v", got)
	}
	f.set(func() {
		f.reply = func(ReplyRequest) (Reply, bool) {
			return Reply{Status: ReplyAnswer, Index: 1, Markdown: "Let's map it: ages first."}, true
		}
	})
	f.reading(t)
	eventually(t, "his answer goes on in the brainstorm", func() bool {
		return strings.Contains(shape(talk.View().Brainstorm), "ages first")
	})
	shown, _ := talk.Op(TalkOpRequest{Op: TalkOpShow, Turns: []KeptTurn{
		{Role: RoleYou, Text: "kept idea", At: 1},
		{Role: RoleBrokk, Text: "kept answer\n\n```brokk-actions\n[\"Yes\"]\n```", At: 2},
		{Role: RoleBrokk, Text: "and more", At: 3},
	}})
	got := shown.View.Brainstorm
	if len(got) != 5 || got[0].Id != got[1].Id || got[2].Id == got[1].Id || !got[1].Still || !got[2].Still {
		t.Fatalf("kept turns %+v", got)
	}
	if got[3].Id != carry || got[4].Id != carry {
		t.Fatalf("the message still answered stays after the kept turns: %+v", got)
	}
	local, _ := talk.Op(TalkOpRequest{Op: TalkOpLocal, Text: "Here we go."})
	if last := local.View.Brainstorm[len(local.View.Brainstorm)-1]; last.Role != RoleBrokk || last.Markdown != "Here we go." || !last.Still {
		t.Fatalf("local line %+v", last)
	}

	g := makeFakeTalk()
	other := g.talk()
	g.set(func() { g.says = []Result{{Status: StatusBusy, Reason: ReasonInProgress}} })
	other.Op(TalkOpRequest{Op: TalkOpSwitch, Conversation: ConversationBrainstorm})
	other.Say(TalkSayRequest{Text: "and for teens?"})
	back, _ := other.Op(TalkOpRequest{Op: TalkOpReturn, Conversation: ConversationBrainstorm})
	if len(back.View.Waiting) != 0 || back.View.Returned[ConversationBrainstorm] != "and for teens?" {
		t.Fatalf("return %+v", back.View)
	}
}

// #2246: the scripted replay is read the way a real answer is, and reaches no session.
func TestAReplayedStepIsReadLikeAnAnswer(t *testing.T) {
	t.Parallel()
	f := makeFakeTalk()
	talk := f.talk()
	talk.Op(TalkOpRequest{Op: TalkOpReplay, Key: "s1", You: "an idea", Markdown: "", Turn: 1, Origin: "tab-a"})
	talk.Op(TalkOpRequest{Op: TalkOpReplay, Key: "s1", You: "an idea", Markdown: "A first line", Turn: 1, Origin: "tab-a"})
	result, _ := talk.Op(TalkOpRequest{Op: TalkOpReplay, Key: "s1", You: "an idea", Markdown: "A first line, whole.", Turn: 1, Final: true, Origin: "tab-a"})
	if shape(result.View.Main) != "you:an idea | brokk:A first line, whole." || !result.View.Main[1].Final || result.View.Main[1].Origin != "tab-a" {
		t.Fatalf("replay %+v", result.View.Main)
	}
	if f.sayCount() != 0 {
		t.Fatal("a replay reached his session")
	}
	if _, err := talk.Op(TalkOpRequest{Op: "drop"}); err == nil {
		t.Fatal("an unknown op was taken")
	}
	if _, err := talk.Op(TalkOpRequest{Op: TalkOpSwitch, Conversation: "other"}); err == nil {
		t.Fatal("an unknown conversation was taken")
	}
}

// #2028: the reading rules, alone.
func TestFollowStep(t *testing.T) {
	t.Parallel()
	answering := TalkState{Phase: PhaseAnswering}
	if s, _, done := followStep(answering, followState{}, nil, false, true); s.Phase != PhaseNeedsAnswer || done {
		t.Fatalf("a wait with no reading: %+v %v", s, done)
	}
	if s, _, done := followStep(answering, followState{}, &Reply{Status: StatusNone}, false, false); s.Phase != PhaseFailed || s.Reason != ReasonGone || !done {
		t.Fatalf("no session: %+v %v", s, done)
	}
	f := followState{}
	var s TalkState
	var done bool
	for i := 0; i < FailedReadingsForNoReply; i++ {
		s, f, done = followStep(answering, f, nil, false, false)
	}
	if s.Phase != PhaseNoReply || !done {
		t.Fatalf("failed readings: %+v %v", s, done)
	}
	s, f, _ = followStep(answering, followState{}, &Reply{Status: ReplyAnswer, Markdown: "Yes."}, true, false)
	if s.Phase != PhaseAnswering || f.idle != 0 || !f.worked {
		t.Fatalf("working: %+v %+v", s, f)
	}
	if got := talkStateOf(nil); got.Phase != PhaseFailed || got.Reason != ReasonUnreachable {
		t.Fatalf("no answer: %+v", got)
	}
	if got := talkStateOf(&Result{Status: StatusMissing, AgentName: "Codex"}); got.Phase != PhaseAgentMissing || got.AgentName != "Codex" {
		t.Fatalf("missing: %+v", got)
	}
}
