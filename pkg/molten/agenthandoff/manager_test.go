// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

type typed struct {
	blockId string
	line    string
}

type fakeEnv struct {
	lock     sync.Mutex
	tokens   map[string]string
	runs     map[string]molten.AgentRunInfo
	locs     map[string]Location
	typed    []typed
	typeOut  func(blockId string) TypeResult
	pages    map[int64][2]string
	notified []molten.NotificationInput
	resolved []string
	dataDir  string
	onNotify func(input molten.NotificationInput)
}

func (e *fakeEnv) VerifyToken(token string) (string, error) {
	if b, ok := e.tokens[token]; ok {
		return b, nil
	}
	return "", errors.New("bad token")
}

func (e *fakeEnv) Runs() []molten.AgentRunInfo {
	e.lock.Lock()
	defer e.lock.Unlock()
	var rtn []molten.AgentRunInfo
	for _, r := range e.runs {
		rtn = append(rtn, r)
	}
	return rtn
}

func (e *fakeEnv) Run(blockId string) (molten.AgentRunInfo, bool) {
	e.lock.Lock()
	defer e.lock.Unlock()
	r, ok := e.runs[blockId]
	return r, ok
}

func (e *fakeEnv) setState(blockId string, state string) {
	e.lock.Lock()
	defer e.lock.Unlock()
	r := e.runs[blockId]
	r.State = state
	e.runs[blockId] = r
}

func (e *fakeEnv) Locate(ctx context.Context, blockId string) (Location, error) {
	if l, ok := e.locs[blockId]; ok {
		return l, nil
	}
	return Location{}, errors.New("not found")
}

func (e *fakeEnv) TypePrompt(ctx context.Context, blockId string, line string) TypeResult {
	out := TypeResult{Sent: true, Submitted: true}
	if e.typeOut != nil {
		if out = e.typeOut(blockId); !out.Sent {
			return out
		}
	}
	e.lock.Lock()
	defer e.lock.Unlock()
	e.typed = append(e.typed, typed{blockId: blockId, line: line})
	return out
}

func (e *fakeEnv) typedLines() []typed {
	e.lock.Lock()
	defer e.lock.Unlock()
	return append([]typed(nil), e.typed...)
}

func (e *fakeEnv) BrowserPage(ctx context.Context, blockId string, tabId int64) (string, string, bool) {
	p, ok := e.pages[tabId]
	return p[0], p[1], ok
}

func (e *fakeEnv) Notify(input molten.NotificationInput) {
	e.lock.Lock()
	e.notified = append(e.notified, input)
	fn := e.onNotify
	e.lock.Unlock()
	if fn != nil {
		go fn(input)
	}
}

func (e *fakeEnv) notifications() []molten.NotificationInput {
	e.lock.Lock()
	defer e.lock.Unlock()
	return append([]molten.NotificationInput(nil), e.notified...)
}

func (e *fakeEnv) ResolveNotification(key string) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.resolved = append(e.resolved, key)
}

func (e *fakeEnv) DataDir() string {
	return e.dataDir
}

// Camille in project A (workspace "A"), Jérôme in project B (workspace "B"), Léa remote.
func makeFixture(t *testing.T) (*Manager, *fakeEnv, string, string) {
	t.Helper()
	root := t.TempDir()
	projA := filepath.Join(root, "projecta")
	projB := filepath.Join(root, "projectb")
	for _, d := range []string{projA, projB} {
		if err := os.MkdirAll(d, 0700); err != nil {
			t.Fatal(err)
		}
	}
	env := &fakeEnv{
		tokens: map[string]string{"tokA": "blockA", "tokB": "blockB", "tokShell": "blockShell"},
		runs: map[string]molten.AgentRunInfo{
			"blockA": {BlockId: "blockA", Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Camille"},
			"blockB": {BlockId: "blockB", Agent: molten.AgentIdCodex, Running: true, State: molten.AgentStateIdle, FirstName: "Jérôme"},
			"blockR": {BlockId: "blockR", Agent: molten.AgentIdClaude, Running: true, State: molten.AgentStateIdle, FirstName: "Léa"},
		},
		locs: map[string]Location{
			"blockA":     {WorkspaceId: "wsA", WorkspaceName: "A", TabName: "T1", Folder: projA, ProjectDir: projA, Local: true},
			"blockB":     {WorkspaceId: "wsB", WorkspaceName: "B", TabName: "T2", Folder: projB, ProjectDir: projB, Local: true},
			"blockR":     {WorkspaceId: "wsA", WorkspaceName: "A", TabName: "T1", Folder: "/remote", Local: false},
			"blockShell": {WorkspaceId: "wsA", WorkspaceName: "A", TabName: "T1", Folder: projA, ProjectDir: projA, Local: true},
		},
		pages:   map[int64][2]string{3: {"https://example.com/doc", "The doc"}},
		dataDir: filepath.Join(root, "data"),
	}
	m := MakeManager(env)
	m.logf = func(string, ...any) {}
	m.sleep = func(time.Duration) { time.Sleep(time.Millisecond) }
	m.queuePoll = time.Millisecond
	// Answered tests return as soon as the answer comes: the wait only bounds a failing run, and a short one would turn
	// a slow answer into a pending request.
	m.approvalTimeout = time.Minute
	return m, env, projA, projB
}

// answerWith answers every approval with the decision, from a window.
func answerWith(m *Manager, env *fakeEnv, decision string) {
	env.lock.Lock()
	defer env.lock.Unlock()
	env.onNotify = func(input molten.NotificationInput) {
		if len(input.Actions) == 0 || input.Actions[0].Gesture != AnswerGesture {
			return
		}
		m.Answer("tab:abc", AnswerRequest{RequestId: input.Actions[0].Args["requestid"].(string), Decision: decision})
	}
}

func TestListMarksYouAndSkipsRemote(t *testing.T) {
	m, _, _, _ := makeFixture(t)
	list, err := m.List(context.Background(), ListRequest{Token: "tokA"})
	if err != nil {
		t.Fatal(err)
	}
	if list.You == nil || list.You.FirstName != "Camille" || list.You.AgentName != "Claude Code" || list.You.Project != "projecta" {
		t.Fatalf("you: %+v", list.You)
	}
	var names []string
	for _, a := range list.Agents {
		names = append(names, a.FirstName)
	}
	if strings.Join(names, ",") != "Camille,Jérôme" {
		t.Fatalf("agents: %v", names)
	}
	if _, err := m.List(context.Background(), ListRequest{Token: "nope"}); err == nil || err.Error() != errNotInMoltenTerm {
		t.Fatalf("bad token: %v", err)
	}
}

func TestSendUnknownNameListsActiveNames(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	_, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Zoé", Brief: Brief{Goal: "do it"}})
	if err == nil || !strings.Contains(err.Error(), "Jérôme (Codex, projectb)") || strings.Contains(err.Error(), "Camille (") {
		t.Fatalf("unknown: %v", err)
	}
	_, err = m.Send(context.Background(), SendRequest{Token: "tokA", To: "camille", Brief: Brief{Goal: "do it"}})
	if err == nil || !strings.Contains(err.Error(), "is you") {
		t.Fatalf("self: %v", err)
	}
	if len(env.notifications()) != 0 {
		t.Fatal("nothing must be asked for a refused send")
	}
}

func TestFirstSendAsksThenAlwaysIsRemembered(t *testing.T) {
	m, env, projA, projB := makeFixture(t)
	answerWith(m, env, DecisionAlways)
	res, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "jerome", Brief: Brief{Goal: "Review the parser", Reply: true}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StatusDelivered || res.To != "Jérôme" {
		t.Fatalf("result: %+v", res)
	}
	notes := env.notifications()
	if len(notes) != 1 || len(notes[0].Actions) != 3 || notes[0].Actions[0].Gesture != AnswerGesture {
		t.Fatalf("approval: %+v", notes)
	}
	if notes[0].BlockId != "blockA" {
		t.Fatalf("approval block: %q", notes[0].BlockId)
	}
	// The windows word the request by its codes (#656).
	if notes[0].TitleText == nil || notes[0].TitleText.Code != "handoff.approval.title" || notes[0].TitleText.Vars["to"] != "Jérôme" ||
		notes[0].MessageText == nil || notes[0].MessageText.Vars["goal"] == "" || notes[0].Actions[0].LabelText == nil {
		t.Fatalf("approval texts: %+v %+v %+v", notes[0].TitleText, notes[0].MessageText, notes[0].Actions[0].LabelText)
	}
	lines := env.typedLines()
	if len(lines) != 1 || lines[0].blockId != "blockB" {
		t.Fatalf("typed: %+v", lines)
	}
	if !strings.HasPrefix(lines[0].line, "[From Camille · Claude Code · projecta] Review the parser Read the brief first: ") ||
		!strings.Contains(lines[0].line, "reply expected: send_to_agent to Camille") {
		t.Fatalf("prompt: %q", lines[0].line)
	}
	if !strings.HasPrefix(res.BriefPath, env.dataDir) || within(res.BriefPath, projA) || within(res.BriefPath, projB) {
		t.Fatalf("brief path: %s", res.BriefPath)
	}
	// Always holds for the pair, in both directions.
	env.onNotify = nil
	if _, err := m.Send(context.Background(), SendRequest{Token: "tokB", To: "Camille", Brief: Brief{Goal: "Done"}}); err != nil {
		t.Fatal(err)
	}
	if len(env.notifications()) != 1 {
		t.Fatal("always must not ask again for the pair")
	}
}

func TestBlockAndNoAnswer(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	answerWith(m, env, DecisionBlock)
	if _, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "x"}}); err == nil || !strings.Contains(err.Error(), "blocked") {
		t.Fatalf("block: %v", err)
	}
	if _, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "x"}}); err == nil || !strings.Contains(err.Error(), "until MoltenTerm restarts") {
		t.Fatalf("blocked pair: %v", err)
	}
	if len(env.typedLines()) != 0 {
		t.Fatal("nothing may be typed for a blocked pair")
	}
}

// waitFor polls a condition; the deadline only bounds a failing run.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (e *fakeEnv) resolvedKeys() []string {
	e.lock.Lock()
	defer e.lock.Unlock()
	return append([]string(nil), e.resolved...)
}

// sendUnanswered sends with no one answering and a wait that ends at once: the request stays pending (#790).
func sendUnanswered(t *testing.T, m *Manager, env *fakeEnv) (SendResult, string) {
	t.Helper()
	m.approvalTimeout = time.Nanosecond
	res, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "Review the parser"}})
	if err != nil {
		t.Fatalf("an unanswered request is not an error: %v", err)
	}
	notes := env.notifications()
	if len(notes) != 1 || len(notes[0].Actions) != 3 {
		t.Fatalf("approval: %+v", notes)
	}
	return res, notes[0].Actions[0].Args["requestid"].(string)
}

// #790: the developer may answer after the sender stopped waiting; nothing is sent before, the brief is delivered
// after, and the sender is told in its terminal.
func TestLateAllowDeliversAndTellsTheSender(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	res, id := sendUnanswered(t, m, env)
	if res.Status != StatusPending || res.BriefPath != "" || !strings.Contains(res.Message, "nothing is sent to Jérôme until they allow it") ||
		strings.Contains(res.Message, "nothing was sent") {
		t.Fatalf("pending: %+v", res)
	}
	if len(env.typedLines()) != 0 || len(env.resolvedKeys()) != 0 {
		t.Fatalf("before the answer: typed %+v, resolved %v", env.typedLines(), env.resolvedKeys())
	}
	if err := m.Answer("tab:abc", AnswerRequest{RequestId: id, Decision: DecisionAlways}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the brief and the receipt", func() bool { return len(env.typedLines()) == 2 })
	lines := env.typedLines()
	if lines[0].blockId != "blockB" || !strings.HasPrefix(lines[0].line, "[From Camille") {
		t.Fatalf("brief prompt: %+v", lines[0])
	}
	if lines[1].blockId != "blockA" || !strings.HasPrefix(lines[1].line, "[MoltenTerm] The developer allowed your handoff to Jérôme. Sent to Jérôme.") {
		t.Fatalf("receipt: %+v", lines[1])
	}
	if keys := env.resolvedKeys(); len(keys) != 1 || keys[0] != NotificationKeyPrefix+id {
		t.Fatalf("the question must be resolved once answered: %v", keys)
	}
	if err := m.Answer("tab:abc", AnswerRequest{RequestId: id, Decision: DecisionOnce}); err == nil {
		t.Fatal("a request answered twice")
	}
	// Always was remembered by the late answer.
	m.approvalTimeout = time.Minute
	if res, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "again"}}); err != nil || res.Status != StatusDelivered {
		t.Fatalf("after always: %+v %v", res, err)
	}
}

func TestLateBlockTellsTheSenderAndSendsNothing(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	_, id := sendUnanswered(t, m, env)
	if err := m.Answer("tab:abc", AnswerRequest{RequestId: id, Decision: DecisionBlock}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the receipt", func() bool { return len(env.typedLines()) == 1 })
	lines := env.typedLines()
	if lines[0].blockId != "blockA" || !strings.Contains(lines[0].line, "blocked handoffs between Camille and Jérôme") {
		t.Fatalf("receipt: %+v", lines)
	}
	if _, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "x"}}); err == nil || !strings.Contains(err.Error(), "until MoltenTerm restarts") {
		t.Fatalf("blocked pair: %v", err)
	}
}

// A sender busy when the late answer comes gets its receipt once its prompt is idle, like any handoff.
func TestLateReceiptWaitsForABusySender(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	_, id := sendUnanswered(t, m, env)
	env.setState("blockA", molten.AgentStateWorking)
	if err := m.Answer("tab:abc", AnswerRequest{RequestId: id, Decision: DecisionOnce}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the receipt queued", func() bool { return m.hasQueue("blockA") })
	if lines := env.typedLines(); len(lines) != 1 || lines[0].blockId != "blockB" {
		t.Fatalf("only the brief may be typed while the sender works: %+v", lines)
	}
	env.setState("blockA", molten.AgentStateIdle)
	waitFor(t, "the receipt", func() bool { return len(env.typedLines()) == 2 })
	if l := env.typedLines()[1]; l.blockId != "blockA" || !strings.HasPrefix(l.line, receiptPrefix) {
		t.Fatalf("receipt: %+v", l)
	}
}

func TestCancelledSendDropsTheRequest(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	m.approvalTimeout = time.Hour
	ctx, cancel := context.WithCancel(context.Background())
	env.onNotify = func(molten.NotificationInput) { cancel() }
	if _, err := m.Send(ctx, SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "x"}}); err == nil || !strings.Contains(err.Error(), "Cancelled") {
		t.Fatalf("cancelled: %v", err)
	}
	id := env.notifications()[0].Actions[0].Args["requestid"].(string)
	if err := m.Answer("tab:abc", AnswerRequest{RequestId: id, Decision: DecisionOnce}); err == nil {
		t.Fatal("a cancelled request was still answerable")
	}
	if len(env.resolvedKeys()) != 1 {
		t.Fatalf("the question must be resolved: %v", env.resolvedKeys())
	}
}

// #790: a prompt typed without Enter tells the developer, with the way to the receiver's terminal.
func TestTypedWithoutEnterIsNotified(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	env.locs["blockB"] = Location{WorkspaceId: "wsB", WorkspaceName: "B", TabId: "tabB", TabName: "T2", Folder: env.locs["blockB"].Folder,
		ProjectDir: env.locs["blockB"].ProjectDir, Local: true}
	answerWith(m, env, DecisionOnce)
	env.typeOut = func(string) TypeResult { return TypeResult{Sent: true} }
	res, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "x"}})
	if err != nil || res.Status != StatusTyped {
		t.Fatalf("typed: %+v %v", res, err)
	}
	notes := env.notifications()
	if len(notes) != 2 {
		t.Fatalf("notifications: %+v", notes)
	}
	n := notes[1]
	if n.Kind != "warning" || n.TitleText == nil || n.TitleText.Code != "handoff.typed.title" || n.TitleText.Vars["receiver"] != "Jérôme" ||
		!strings.Contains(n.Title, "press Enter") || n.BlockId != "blockB" {
		t.Fatalf("typed notification: %+v", n)
	}
	if len(n.Actions) != 1 || n.Actions[0].Kind != "open" || n.Actions[0].BlockId != "blockB" || n.Actions[0].TabId != "tabB" ||
		n.Actions[0].WorkspaceId != "wsB" || n.Actions[0].LabelText == nil || n.Actions[0].LabelText.Code != "handoff.typed.goto" {
		t.Fatalf("go to action: %+v", n.Actions)
	}
}

func TestOnlyAWindowAnswers(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	answered := make(chan error, 1)
	env.onNotify = func(input molten.NotificationInput) {
		id := input.Actions[0].Args["requestid"].(string)
		err := m.Answer("proc:term", AnswerRequest{RequestId: id, Decision: DecisionOnce})
		answered <- err
		m.Answer("tab:x", AnswerRequest{RequestId: id, Decision: DecisionDismiss})
	}
	_, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "x"}})
	if err == nil || err.Error() != errDismissed {
		t.Fatalf("dismissed: %v", err)
	}
	if aerr := <-answered; aerr == nil || aerr.Error() != errNotUi {
		t.Fatalf("a terminal answered: %v", aerr)
	}
}

func TestBusyReceiverIsQueued(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	answerWith(m, env, DecisionOnce)
	env.setState("blockB", molten.AgentStateWorking)
	res, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "later"}})
	if err != nil || res.Status != StatusQueued {
		t.Fatalf("queued: %+v %v", res, err)
	}
	time.Sleep(20 * time.Millisecond)
	if len(env.typedLines()) != 0 {
		t.Fatal("typed while the receiver works")
	}
	env.setState("blockB", molten.AgentStateDone)
	deadline := time.Now().Add(2 * time.Second)
	for len(env.typedLines()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if lines := env.typedLines(); len(lines) != 1 || !strings.Contains(lines[0].line, "later") {
		t.Fatalf("delivered: %+v", lines)
	}
}

func TestQueueDropsAnEndedReceiver(t *testing.T) {
	m, env, _, _ := makeFixture(t)
	answerWith(m, env, DecisionOnce)
	env.typeOut = func(string) TypeResult { return TypeResult{Retry: true, Message: "vim is in the foreground"} }
	if res, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "x"}}); err != nil || res.Status != StatusQueued {
		t.Fatalf("queued: %+v %v", res, err)
	}
	env.lock.Lock()
	delete(env.runs, "blockB")
	env.lock.Unlock()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		notes := env.notifications()
		if len(notes) == 2 && notes[1].Kind == "error" && strings.Contains(notes[1].Message, "ended") {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no undelivered notice: %+v", env.notifications())
}

func TestBriefFilesLinksAndSnapshots(t *testing.T) {
	m, env, projA, projB := makeFixture(t)
	answerWith(m, env, DecisionOnce)
	src := filepath.Join(projA, "parser.go")
	os.WriteFile(src, []byte("line1\nline2\nline3 ```\nline4\n"), 0600)
	secret := filepath.Join(projA, ".env")
	os.WriteFile(secret, []byte("TOKEN=x"), 0600)
	inB := filepath.Join(projB, "main.go")
	os.WriteFile(inB, []byte("package main\n"), 0600)
	brief := Brief{
		Goal:    "Port the parser",
		Context: "Decided to keep the AST.\nOpen question: errors.",
		Files: []FileRef{
			{Path: src, Project: "projecta", Lines: "2-3"},
			{Path: secret},
			{Path: "main.go"},
			{Path: inB},
			{Path: filepath.Join(projA, "gone.go")},
		},
		Links: []LinkRef{{Url: "https://github.com/o/r/issues/1", Kind: "ticket"}, {TabId: 3}},
	}
	res, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: brief})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(res.BriefPath)
	if err != nil {
		t.Fatal(err)
	}
	md := string(data)
	for _, want := range []string{
		"# Handoff from Camille to Jérôme", "## Goal\n\nPort the parser", "Open question: errors.",
		"Snapshot: `" + filepath.Join(filepath.Dir(res.BriefPath), SnapshotDirName, "01-parser.go"),
		"````\n  line2\n  line3 ```\n  ````", "not copied: it may hold secrets", "Not found when the brief was written",
		"[The doc](https://example.com/doc) (browser page)", "call `tabs_create`, then `navigate`",
		"[https://github.com/o/r/issues/1](https://github.com/o/r/issues/1) (ticket)",
	} {
		if !strings.Contains(md, want) {
			t.Fatalf("brief lacks %q:\n%s", want, md)
		}
	}
	// main.go is relative to the sender's folder: projecta/main.go, which does not exist; projectb's file is the
	// receiver's own and is not copied.
	if !strings.Contains(md, filepath.Join(projA, "main.go")) || strings.Contains(md, "02-main.go") || strings.Contains(md, "04-main.go") {
		t.Fatalf("files:\n%s", md)
	}
	snap, err := os.ReadFile(filepath.Join(filepath.Dir(res.BriefPath), SnapshotDirName, "01-parser.go"))
	if err != nil || !strings.HasPrefix(string(snap), "line1") {
		t.Fatalf("snapshot: %v", err)
	}
	for _, proj := range []string{projA, projB} {
		entries, _ := os.ReadDir(proj)
		for _, e := range entries {
			switch e.Name() {
			case "parser.go", ".env", "main.go":
			default:
				t.Fatalf("written in a project: %s", filepath.Join(proj, e.Name()))
			}
		}
	}
	if _, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "x", Links: []LinkRef{{TabId: 9}}}}); err == nil || !strings.Contains(err.Error(), "browser tab 9") {
		t.Fatalf("unknown tab: %v", err)
	}
}

// #664: a file that may hold secrets is never quoted, whether it is in the receiver's project, outside every project
// or behind a link; the brief says why.
func TestBriefNeverQuotesSecrets(t *testing.T) {
	m, env, projA, projB := makeFixture(t)
	answerWith(m, env, DecisionOnce)
	home := t.TempDir()
	write := func(path string, content string) string {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	envB := write(filepath.Join(projB, ".env"), "SECRET_ENV_B=1\n")
	aws := write(filepath.Join(home, ".aws", "credentials"), "[default]\nSECRET_AWS=1\n")
	gitCreds := write(filepath.Join(home, ".git-credentials"), "https://u:SECRET_GIT@github.com\n")
	tfvars := write(filepath.Join(projA, "prod.tfvars"), "SECRET_TF=1\n")
	kube := write(filepath.Join(home, ".kube", "config"), "SECRET_KUBE=1\n")
	link := filepath.Join(projA, "notes.txt")
	if err := os.Symlink(envB, link); err != nil {
		t.Fatal(err)
	}
	plain := write(filepath.Join(projA, "plain.txt"), "visible line\n")
	var files []FileRef
	for _, p := range []string{envB, aws, gitCreds, tfvars, kube, link, plain} {
		files = append(files, FileRef{Path: p, Lines: "1-40"})
	}
	res, err := m.Send(context.Background(), SendRequest{Token: "tokA", To: "Jérôme", Brief: Brief{Goal: "Check the config", Files: files}})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(res.BriefPath)
	if err != nil {
		t.Fatal(err)
	}
	md := string(data)
	for _, secret := range []string{"SECRET_ENV_B", "SECRET_AWS", "SECRET_GIT", "SECRET_TF", "SECRET_KUBE"} {
		if strings.Contains(md, secret) {
			t.Errorf("%s quoted:\n%s", secret, md)
		}
	}
	if n := strings.Count(md, "Lines 1-40 not quoted: it may hold secrets."); n != 6 {
		t.Errorf("%d refusals, want 6:\n%s", n, md)
	}
	if !strings.Contains(md, "visible line") {
		t.Errorf("an ordinary file was not quoted:\n%s", md)
	}
}

func TestCleanBriefRefusals(t *testing.T) {
	cases := []Brief{
		{},
		{Goal: "x", Files: []FileRef{{Path: ""}}},
		{Goal: "x", Files: []FileRef{{Path: "/a", Lines: "z"}}},
		{Goal: "x", Links: []LinkRef{{Url: "javascript:alert(1)", Kind: "browser"}}},
		{Goal: "x", Links: []LinkRef{{Url: "u", Kind: "video"}}},
	}
	for i, c := range cases {
		if _, err := cleanBrief(c, "/w"); err == nil {
			t.Fatalf("case %d accepted", i)
		}
	}
	b, err := cleanBrief(Brief{Goal: " do\x1b[31m it ", Files: []FileRef{{Path: "rel/x.go"}}}, "/w")
	if err != nil || b.Goal != "do[31m it" || b.Files[0].Path != "/w/rel/x.go" {
		t.Fatalf("cleaned: %+v %v", b, err)
	}
}

func TestPromptLineStaysShort(t *testing.T) {
	from := Party{FirstName: "Camille", AgentName: "Claude Code", Project: "projecta"}
	line := promptLine(from, Brief{Goal: strings.Repeat("é", 1000)}, "/data/molten/handoffs/x/brief.md")
	if len(line) > maxPromptBytes || !strings.HasSuffix(line, "Read the brief first: /data/molten/handoffs/x/brief.md") {
		t.Fatalf("%d %q", len(line), line)
	}
	shell := promptLine(Party{Project: "p"}, Brief{Goal: "g"}, "/b")
	if shell != "[From a terminal · p] g Read the brief first: /b" {
		t.Fatalf("%q", shell)
	}
}

func TestSweepOldBriefs(t *testing.T) {
	root := t.TempDir()
	old := filepath.Join(root, "old")
	fresh := filepath.Join(root, "fresh")
	os.Mkdir(old, 0700)
	os.Mkdir(fresh, 0700)
	past := time.Now().Add(-BriefRetention - time.Hour)
	os.Chtimes(old, past, past)
	sweepBriefs(root, time.Now())
	if _, err := os.Stat(old); err == nil {
		t.Fatal("old brief kept")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("fresh brief removed")
	}
}
