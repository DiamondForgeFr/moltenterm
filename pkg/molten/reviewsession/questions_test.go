// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// fakeAgent is the session's agent as its hooks report it, and what MoltenTerm typed into it.
type fakeAgent struct {
	lock  sync.Mutex
	state string
	// typed: each line with the question review_selection gave when it was typed.
	typed   []string
	outcome TypeOutcome
	m       *Manager
	key     mcpreview.SessionKey
}

func (a *fakeAgent) setState(state string) {
	a.lock.Lock()
	defer a.lock.Unlock()
	a.state = state
}

func (a *fakeAgent) setOutcome(out TypeOutcome) {
	a.lock.Lock()
	defer a.lock.Unlock()
	a.outcome = out
}

func (a *fakeAgent) lines() []string {
	a.lock.Lock()
	defer a.lock.Unlock()
	return append([]string(nil), a.typed...)
}

func (a *fakeAgent) run(blockId string) (molten.AgentRunInfo, bool) {
	a.lock.Lock()
	defer a.lock.Unlock()
	return molten.AgentRunInfo{BlockId: blockId, Running: true, State: a.state}, true
}

func (a *fakeAgent) typePrompt(ctx context.Context, blockId string, line string) TypeOutcome {
	selected := ""
	if s := a.m.find(a.key); s != nil {
		a.m.lock.Lock()
		if s.selection != nil {
			selected = s.selection.Question
		}
		a.m.lock.Unlock()
	}
	a.lock.Lock()
	defer a.lock.Unlock()
	if a.state == molten.AgentStateWorking {
		return TypeOutcome{Retry: true, Message: "Claude Code is working."}
	}
	a.typed = append(a.typed, line+" ["+selected+"]")
	return a.outcome
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func startQueueSession(t *testing.T) (*Manager, *fakeAgent, mcpreview.SessionKey) {
	t.Helper()
	repo := makeTestRepo(t)
	f := makeFakeWave()
	env := f.env(repo, t.TempDir())
	key := mcpreview.SessionKey{Repo: "Owner/Repo", Number: 7}
	agent := &fakeAgent{state: molten.AgentStateIdle, outcome: TypeOutcome{Sent: true, Submitted: true}, key: key}
	env.AgentRun = agent.run
	env.TypePrompt = agent.typePrompt
	env.Sleep = func(time.Duration) { time.Sleep(2 * time.Millisecond) }
	m := MakeManager(env)
	agent.m = m
	if _, err := m.Start(context.Background(), "", startReq(repo)); err != nil {
		t.Fatal(err)
	}
	<-f.typedCh
	return m, agent, key
}

func anchorAt(line int) *mcpreview.Anchor {
	return &mcpreview.Anchor{Path: "main.go", Side: mcpreview.SideRight, Line: line}
}

// FR-REV-006 AC4: questions asked while the agent works are queued, shown, and typed once it is idle, oldest first,
// each with its own selection; a removed one is never typed.
func TestQuestionsQueue(t *testing.T) {
	m, agent, key := startQueueSession(t)
	ctx := context.Background()
	agent.setState(molten.AgentStateWorking)
	var ids []string
	for i, q := range []string{"un ?", "deux ?", "trois ?"} {
		out, err := m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Anchor: anchorAt(i + 1), Question: q})
		if err != nil || out.Sent || !out.Queued || out.Position != i+1 {
			t.Fatalf("ask %d: %+v %v", i, out, err)
		}
		ids = append(ids, out.QuestionId)
	}
	if out, _ := m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Question: "x"}); out.Busy {
		t.Errorf("a question behind others is not refused by a busy agent: %+v", out)
	} else {
		m.CancelQuestion(ctx, mcpreview.AskCancelRequest{SessionKey: key, QuestionId: out.QuestionId})
	}
	if err := m.CancelQuestion(ctx, mcpreview.AskCancelRequest{SessionKey: key, QuestionId: ids[1]}); err != nil {
		t.Fatal(err)
	}
	if err := m.CancelQuestion(ctx, mcpreview.AskCancelRequest{SessionKey: key, QuestionId: ids[1]}); err == nil {
		t.Error("removed twice")
	}
	info := m.Get(ctx, key)
	if len(info.Questions) != 2 || info.Questions[0].Question != "un ?" || info.Questions[1].Anchor.Line != 3 {
		t.Fatalf("queue %+v", info.Questions)
	}
	time.Sleep(20 * time.Millisecond)
	if len(agent.lines()) != 0 {
		t.Fatalf("typed while working: %q", agent.lines())
	}
	agent.setState(molten.AgentStateIdle)
	waitFor(t, "both questions", func() bool { return len(agent.lines()) == 2 })
	got := agent.lines()
	if !strings.Contains(got[0], "line 1 (review_selection has them): un ? [un ?]") ||
		!strings.Contains(got[1], "line 3 (review_selection has them): trois ? [trois ?]") {
		t.Errorf("typed %q", got)
	}
	waitFor(t, "an empty queue", func() bool { return len(m.Get(ctx, key).Questions) == 0 })
	m.End(ctx, key)
}

// A queued question typed after a draft of the developer's waits for Enter: the next one is not typed into the same
// prompt; it goes once the agent has worked on the first.
func TestQuestionsHoldAfterDraft(t *testing.T) {
	m, agent, key := startQueueSession(t)
	ctx := context.Background()
	agent.setState(molten.AgentStateWaiting)
	m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Question: "un ?"})
	m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Question: "deux ?"})
	agent.setOutcome(TypeOutcome{Sent: true})
	agent.setState(molten.AgentStateIdle)
	waitFor(t, "the first question", func() bool { return len(agent.lines()) == 1 })
	waitFor(t, "the hold note", func() bool { return strings.Contains(m.Get(ctx, key).QueueNote, "press Enter") })
	time.Sleep(20 * time.Millisecond)
	if len(agent.lines()) != 1 {
		t.Fatalf("typed into the held prompt: %q", agent.lines())
	}
	agent.setOutcome(TypeOutcome{Sent: true, Submitted: true})
	agent.setState(molten.AgentStateWorking)
	waitFor(t, "the hold to end", func() bool { return m.Get(ctx, key).QueueNote == "" })
	agent.setState(molten.AgentStateIdle)
	waitFor(t, "the second question", func() bool { return len(agent.lines()) == 2 })
	m.End(ctx, key)
}

// The queue ends with the session; a busy agent keeps the selection it is answering.
func TestQuestionsEndWithSession(t *testing.T) {
	m, agent, key := startQueueSession(t)
	ctx := context.Background()
	if out, _ := m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Anchor: anchorAt(2), Question: "first"}); !out.Sent {
		t.Fatalf("idle agent: %+v", out)
	}
	agent.setState(molten.AgentStateWorking)
	m.Ask(ctx, mcpreview.AskRequest{SessionKey: key, Anchor: anchorAt(3), Question: "second"})
	raw, _ := json.Marshal(m.toolSelection(m.find(key)))
	if !strings.Contains(string(raw), "first") {
		t.Errorf("the selection changed under the agent: %s", raw)
	}
	s := m.find(key)
	m.End(ctx, key)
	agent.setState(molten.AgentStateIdle)
	waitFor(t, "the loop to stop", func() bool {
		m.lock.Lock()
		defer m.lock.Unlock()
		return !s.queueRunning
	})
	if len(agent.lines()) != 1 {
		t.Errorf("typed after the session ended: %q", agent.lines())
	}
}

// FR-REV-006 AC2, AC3: an answer is a card on the question's lines (head and excerpt filled from the selection), a
// question on the PR has none, and a follow-up replaces a card in place under its id; ids are unique per session.
func TestAnswerCards(t *testing.T) {
	repo := makeTestRepo(t)
	f := makeFakeWave()
	m := MakeManager(f.env(repo, t.TempDir()))
	ctx := context.Background()
	res, _ := m.Start(ctx, "tab1", startReq(repo))
	blockId := <-f.typedCh
	token := f.blocks[blockId].Meta.GetMap(waveobj.MetaKey_CmdEnv).GetString(mcpreview.SessionTokenVarName, "")
	hello, err := m.Hello(ctx, "proc:9", mcpreview.HelloRequest{Token: "jwt-" + blockId, SessionToken: token})
	if err != nil {
		t.Fatal(err)
	}
	call := func(args string) mcpbrowser.CallResult {
		return m.Call(ctx, "proc:9", mcpreview.CallRequest{ConnId: hello.ConnId, Tool: mcpreview.ToolPostExplanation, Args: json.RawMessage(args)})
	}
	sel := &mcpreview.Anchor{Path: "main.go", Side: mcpreview.SideRight, StartLine: 3, Line: 5, HeadOid: repo.head, Excerpt: "func main() {"}
	m.SetSelection(ctx, mcpreview.SelectionRequest{SessionKey: mcpreview.SessionKey{Id: res.Session.Id}, Anchor: sel, Question: "pourquoi ?"})
	if r := call(`{"anchor":{"path":"main.go","side":"RIGHT","startline":3,"line":5},"question":"pourquoi ?","markdown":"Parce que.","sources":["main.go:3-5"]}`); r.IsError {
		t.Fatalf("anchored %+v", r)
	}
	if r := call(`{"question":"résume","markdown":"La PR ajoute hi.","sources":["main.go:4"]}`); r.IsError {
		t.Fatalf("on the PR %+v", r)
	}
	posts, _ := m.Posts(ctx, mcpreview.SessionKey{Id: res.Session.Id})
	if len(posts.Posts) != 2 {
		t.Fatalf("posts %+v", posts)
	}
	first, onPr := posts.Posts[0], posts.Posts[1]
	if first.Anchor == nil || first.Anchor.HeadOid != repo.head || first.Anchor.Excerpt != "func main() {" || first.Question != "pourquoi ?" {
		t.Errorf("anchored card %+v %+v", first, first.Anchor)
	}
	if onPr.Anchor != nil || !postIdPattern.MatchString(first.Id) || first.Id == onPr.Id {
		t.Errorf("cards %+v %+v", first, onPr)
	}
	if r := call(`{"explanationid":"` + first.Id + `","markdown":"Parce que, en détail.","depth":"detailed","sources":["main.go:3-5"]}`); r.IsError || !strings.Contains(r.Content[0].Text, first.Id) {
		t.Fatalf("follow-up %+v", r)
	}
	posts, _ = m.Posts(ctx, mcpreview.SessionKey{Id: res.Session.Id})
	if len(posts.Posts) != 2 || posts.Posts[1].Id != first.Id || posts.Posts[1].Depth != mcpreview.DepthDetailed {
		t.Errorf("after the follow-up %+v", posts.Posts)
	}
	for _, bad := range []string{`{"explanationid":"../x","markdown":"x"}`, `{"anchor":{"path":"a","side":"RIGHT","line":0},"markdown":"x"}`} {
		if r := call(bad); !r.IsError {
			t.Errorf("%s accepted", bad)
		}
	}
	other := MakeManager(f.env(repo, t.TempDir()))
	s := &session{rec: record{Id: "x", Repo: "o/r", Number: 1}}
	p, _ := other.addPost(s, mcpreview.Post{Kind: mcpreview.PostExplanation, Markdown: "x"})
	if p.Id == first.Id {
		t.Errorf("two sessions gave the same id %s", p.Id)
	}
}
