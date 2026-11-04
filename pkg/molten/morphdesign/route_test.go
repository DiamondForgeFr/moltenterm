// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package morphdesign

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

type fakeAgent struct {
	first string
	agent string
}

// fakeBackend is a workspace with an agent's terminal in tab-chat and the design's own tab, tab-design, once it opens.
type fakeBackend struct {
	lock       sync.Mutex
	tabOf      map[string]string
	designTabs map[string]string
	terminals  map[string][]string
	agents     map[string]fakeAgent
	opened     []molten.MorphDesignTabRequest
	handoffs   []molten.MorphDesignHandoff
}

func makeFakeBackend() *fakeBackend {
	return &fakeBackend{
		tabOf:      map[string]string{routetest.TerminalBlock: "tab-chat", "block-left": "tab-design"},
		designTabs: map[string]string{"tab-design": "branch-box"},
		terminals:  map[string][]string{"tab-design": {"block-left"}},
		agents:     map[string]fakeAgent{routetest.TerminalBlock: {first: "Marion", agent: "claude-code"}},
	}
}

func (b *fakeBackend) Locate(blockId string) (string, string, error) {
	b.lock.Lock()
	defer b.lock.Unlock()
	tab, ok := b.tabOf[blockId]
	if !ok {
		return "", "", errors.New("no tab")
	}
	return "ws-1", tab, nil
}

func (b *fakeBackend) DesignOfTab(tabId string) string {
	b.lock.Lock()
	defer b.lock.Unlock()
	return b.designTabs[tabId]
}

func (b *fakeBackend) TerminalsOfTab(tabId string) []string {
	b.lock.Lock()
	defer b.lock.Unlock()
	return append([]string{}, b.terminals[tabId]...)
}

func (b *fakeBackend) Agent(blockId string) (string, string, bool) {
	b.lock.Lock()
	defer b.lock.Unlock()
	a, ok := b.agents[blockId]
	return a.first, a.agent, ok
}

func (b *fakeBackend) setAgent(blockId string, a *fakeAgent) {
	b.lock.Lock()
	defer b.lock.Unlock()
	if a == nil {
		delete(b.agents, blockId)
		return
	}
	b.agents[blockId] = *a
}

func (b *fakeBackend) OpenTab(req molten.MorphDesignTabRequest) (molten.MorphDesignTabResult, error) {
	b.lock.Lock()
	defer b.lock.Unlock()
	b.opened = append(b.opened, req)
	return molten.MorphDesignTabResult{TabId: "tab-design", Created: len(b.opened) == 1}, nil
}

func (b *fakeBackend) PublishHandoff(workspaceId string, h molten.MorphDesignHandoff) {
	b.lock.Lock()
	defer b.lock.Unlock()
	if workspaceId != h.WorkspaceId {
		panic("the hand-off goes to its own workspace")
	}
	b.handoffs = append(b.handoffs, h)
}

type sent struct {
	block string
	goal  string
}

type fakeSender struct {
	lock   sync.Mutex
	sent   []sent
	result SendResult
	err    error
}

func (f *fakeSender) send(_ context.Context, blockId string, goal string) (SendResult, error) {
	f.lock.Lock()
	defer f.lock.Unlock()
	f.sent = append(f.sent, sent{blockId, goal})
	return f.result, f.err
}

func (f *fakeSender) messages() []sent {
	f.lock.Lock()
	defer f.lock.Unlock()
	return append([]sent{}, f.sent...)
}

type fixture struct {
	t       *testing.T
	e       *routetest.Env
	link    *localroute.Link
	s       *Service
	b       *fakeBackend
	sender  *fakeSender
	dir     string
	handoff string
}

func makeFixture(t *testing.T) *fixture {
	t.Helper()
	e := routetest.Make(t)
	b := makeFakeBackend()
	sender := &fakeSender{result: SendResult{Status: molten.MorphToldSent, To: "Marion"}}
	s := MakeService(MakeStore(nil), b, sender.send)
	link, err := localroute.MakeLink(e.Router, s.route())
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{t: t, e: e, link: link, s: s, b: b, sender: sender, dir: t.TempDir()}
}

func (f *fixture) ask(from routetest.From, command string, req molten.MorphDesignRequest, out any) string {
	f.t.Helper()
	data, errStr := routetest.Ask(f.t, f.link, from, command, req)
	if errStr == "" && out != nil {
		if err := utilfn.ReUnmarshal(out, data); err != nil {
			f.t.Fatal(err)
		}
	}
	return errStr
}

func (f *fixture) agentCall(command string, req molten.MorphDesignRequest) molten.MorphDesign {
	f.t.Helper()
	var d molten.MorphDesign
	if errStr := f.ask(f.e.Terminal(), command, req, &d); errStr != "" {
		f.t.Fatalf("%s: %s", command, errStr)
	}
	return d
}

func (f *fixture) open() molten.MorphDesignOpened {
	f.t.Helper()
	var opened molten.MorphDesignOpened
	if errStr := f.ask(f.e.Terminal(), molten.MorphDesignOpenCommand, molten.MorphDesignRequest{Mod: "branch-box", Name: "Branch box", Cwd: f.dir}, &opened); errStr != "" {
		f.t.Fatalf("open: %s", errStr)
	}
	return opened
}

func (f *fixture) windowCall(command string, req molten.MorphDesignRequest) (molten.MorphDesign, string) {
	f.t.Helper()
	req.Mod = "branch-box"
	var d molten.MorphDesign
	errStr := f.ask(f.e.Window(), command, req, &d)
	return d, errStr
}

// The agent's commands are the terminals', the panel's the windows': an agent never clicks for the developer, and a
// remote host reaches neither.
func TestCommandsAreAnsweredToTheirOwnCallers(t *testing.T) {
	f := makeFixture(t)
	f.open()
	req := molten.MorphDesignRequest{Mod: "branch-box", Key: "audience", Value: "Just me", Action: molten.MorphActionAgree}
	for _, command := range windowCommands {
		routetest.MustRefuseWith(t, f.link, f.e.NonWindows(), command, req, "answered to a MoltenTerm window")
	}
	for _, command := range agentCommands {
		routetest.MustRefuse(t, f.link, f.e.NonLocal(), command, req)
		if _, errStr := routetest.Ask(t, f.link, f.e.Window(), command, req); !strings.Contains(errStr, "terminal") {
			t.Errorf("%s from a window: %q", command, errStr)
		}
	}
	if len(f.sender.messages()) != 0 {
		t.Fatal("a refused caller reached the agent")
	}
	d, _ := f.s.Store.Get("branch-box")
	if len(d.Questions) != 0 {
		t.Fatalf("a refused caller changed the design: %+v", d.Questions)
	}
}

func TestOpenAsksTheTerminalsWindowToShowTheTab(t *testing.T) {
	f := makeFixture(t)
	opened := f.open()
	if len(f.b.handoffs) != 1 {
		t.Fatalf("%d hand-offs", len(f.b.handoffs))
	}
	h := f.b.handoffs[0]
	if h.Id == "" || h.Id != opened.HandoffId || h.WorkspaceId != "ws-1" || h.Mod != "branch-box" || h.Dir != f.dir || h.Name != "Branch box" {
		t.Fatalf("the hand-off: %+v for %+v", h, opened)
	}
	if opened.Design.Opened != "" || opened.Design.TabId != "" {
		t.Fatalf("no window answered yet: %+v", opened.Design)
	}
	if opened.Design.Agent == nil || opened.Design.Agent.FirstName != "Marion" {
		t.Fatalf("the agent that opened it receives the clicks: %+v", opened.Design.Agent)
	}
}

func TestOpenRefusesWhatItCannotShow(t *testing.T) {
	f := makeFixture(t)
	for name, req := range map[string]molten.MorphDesignRequest{
		"no mod":       {Cwd: f.dir},
		"bad mod":      {Mod: "Branch Box", Cwd: f.dir},
		"no folder":    {Mod: "branch-box"},
		"relative":     {Mod: "branch-box", Cwd: "work/app"},
		"missing path": {Mod: "branch-box", Cwd: f.dir + "/missing"},
	} {
		if errStr := f.ask(f.e.Terminal(), molten.MorphDesignOpenCommand, req, nil); errStr == "" {
			t.Errorf("%s: open was accepted", name)
		}
	}
	if len(f.b.handoffs) != 0 {
		t.Fatal("a refused open asked the window")
	}
}

func TestTheWindowMakesTheTabAndTheDesignRemembersIt(t *testing.T) {
	f := makeFixture(t)
	opened := f.open()
	var result molten.MorphDesignTabResult
	if errStr := f.ask(f.e.Window(), molten.MorphDesignTabCommand,
		molten.MorphDesignRequest{Mod: "branch-box", Handoff: opened.HandoffId, TabName: "Conception · Branch box"}, &result); errStr != "" {
		t.Fatal(errStr)
	}
	if result.TabId != "tab-design" || len(f.b.opened) != 1 {
		t.Fatalf("the tab: %+v %+v", result, f.b.opened)
	}
	if req := f.b.opened[0]; req.WorkspaceId != "ws-1" || req.Dir != f.dir || req.TabName != "Conception · Branch box" || req.Mod != "branch-box" {
		t.Fatalf("the tab request: %+v", req)
	}
	d := f.agentCall(molten.MorphDesignShowCommand, molten.MorphDesignRequest{Mod: "branch-box"})
	if d.TabId != "tab-design" || d.Opened != opened.HandoffId {
		t.Fatalf("the design must say the window answered this hand-off: %+v", d)
	}
}

func TestAgentCommandsFindTheirDesign(t *testing.T) {
	f := makeFixture(t)
	f.open()
	var other molten.MorphDesignOpened
	if errStr := f.ask(f.e.Terminal(), molten.MorphDesignOpenCommand, molten.MorphDesignRequest{Mod: "clock", Cwd: f.dir}, &other); errStr != "" {
		t.Fatal(errStr)
	}
	// The terminal drove the last design it opened, not both: the mod is named when it is ambiguous.
	f.s.Store.SetDriver("branch-box", "")
	f.s.Store.SetDriver("clock", "")
	if errStr := f.ask(f.e.Terminal(), molten.MorphDesignStepCommand, molten.MorphDesignRequest{Step: molten.MorphStepPlan}, nil); !strings.Contains(errStr, "several designs are open") {
		t.Fatalf("two designs and no name: %q", errStr)
	}
	d := f.agentCall(molten.MorphDesignStepCommand, molten.MorphDesignRequest{Mod: "clock", Step: molten.MorphStepPlan})
	if d.Mod != "clock" || d.Current != molten.MorphStepPlan {
		t.Fatalf("a named design: %+v", d)
	}
	if errStr := f.ask(f.e.Terminal(), molten.MorphDesignStepCommand, molten.MorphDesignRequest{Mod: "nope", Step: molten.MorphStepPlan}, nil); !strings.Contains(errStr, "molten morph design nope") {
		t.Fatalf("an unknown design: %q", errStr)
	}
	// The terminal that last drove a design is its default.
	f.s.Store.SetDriver("clock", routetest.TerminalBlock)
	if d := f.agentCall(molten.MorphDesignShowCommand, molten.MorphDesignRequest{}); d.Mod != "clock" {
		t.Fatalf("the design this terminal drives: %+v", d)
	}
}

func TestATerminalInTheDesignTabUsesThatDesign(t *testing.T) {
	f := makeFixture(t)
	f.open()
	f.b.lock.Lock()
	f.b.tabOf[routetest.TerminalBlock] = "tab-design"
	f.b.lock.Unlock()
	f.s.Store.SetDriver("branch-box", "")
	if _, errStr := routetest.Ask(t, f.link, f.e.Terminal(), molten.MorphDesignOpenCommand, molten.MorphDesignRequest{Mod: "clock", Cwd: f.dir}); errStr != "" {
		t.Fatal(errStr)
	}
	f.s.Store.SetDriver("clock", "")
	if d := f.agentCall(molten.MorphDesignShowCommand, molten.MorphDesignRequest{}); d.Mod != "branch-box" {
		t.Fatalf("the design of the terminal's own tab: %+v", d)
	}
}

func TestTheAgentDrivesThePanelThroughItsCommands(t *testing.T) {
	f := makeFixture(t)
	f.open()
	d := f.agentCall(molten.MorphDesignAskCommand, molten.MorphDesignRequest{
		Mod: "branch-box", Key: "audience", Text: "Who?", Choices: []molten.MorphDesignChoice{{Label: "Just me"}, {Label: "My team"}},
	})
	if len(d.Questions) != 1 || d.Current != molten.MorphStepQuestions {
		t.Fatalf("ask: %+v", d)
	}
	d = f.agentCall(molten.MorphDesignPlanCommand, molten.MorphDesignRequest{Mod: "branch-box", Plan: &molten.MorphDesignPlan{Summary: "A box."}})
	if d.Plan == nil || d.Current != molten.MorphStepPlan {
		t.Fatalf("plan: %+v", d)
	}
	d = f.agentCall(molten.MorphDesignDraftCommand, molten.MorphDesignRequest{Mod: "branch-box", Draft: &molten.MorphDesignDraft{Boxes: []string{"Branch"}}})
	if d.Draft.State != molten.MorphDraftSample || d.Current != molten.MorphStepPreview {
		t.Fatalf("draft: %+v", d)
	}
	d = f.agentCall(molten.MorphDesignAnswerCommand, molten.MorphDesignRequest{Mod: "branch-box", Key: "audience", Value: "Both"})
	if d.Questions[0].Answer != "Both" || d.Questions[0].AnsweredBy != molten.MorphByTerminal {
		t.Fatalf("answer: %+v", d.Questions)
	}
	if errStr := f.ask(f.e.Terminal(), molten.MorphDesignPlanCommand, molten.MorphDesignRequest{Mod: "branch-box"}, nil); errStr == "" {
		t.Error("a plan command without a plan was accepted")
	}
}

func TestAClickInThePanelReachesTheAgentAsAPromptLine(t *testing.T) {
	f := makeFixture(t)
	f.open()
	f.agentCall(molten.MorphDesignAskCommand, molten.MorphDesignRequest{
		Mod: "branch-box", Key: "audience", Text: "Who will use it?", Choices: []molten.MorphDesignChoice{{Label: "Just me"}, {Label: "My team"}},
	})
	d, errStr := f.windowCall(molten.MorphDesignChooseCommand, molten.MorphDesignRequest{Key: "audience", Value: "My team"})
	if errStr != "" {
		t.Fatal(errStr)
	}
	msgs := f.sender.messages()
	if len(msgs) != 1 || msgs[0].block != routetest.TerminalBlock {
		t.Fatalf("the click went to %+v", msgs)
	}
	for _, want := range []string{"branch-box", "My team", "Who will use it?", "audience"} {
		if !strings.Contains(msgs[0].goal, want) {
			t.Errorf("the line lacks %q: %s", want, msgs[0].goal)
		}
	}
	if d.Questions[0].Answer != "My team" || d.Told == nil || d.Told.Status != molten.MorphToldSent || d.Told.To != "Marion" {
		t.Fatalf("what became of the click: %+v %+v", d.Questions[0], d.Told)
	}
	if _, errStr := f.windowCall(molten.MorphDesignChooseCommand, molten.MorphDesignRequest{Key: "audience", Value: "Everybody"}); errStr == "" {
		t.Error("a label that is not a choice was accepted")
	}
	if len(f.sender.messages()) != 1 {
		t.Error("a refused click reached the agent")
	}
}

// With nobody to take the click, the panel does not block: the answer stays in the design for the agent that comes.
func TestAClickWithNoAgentStaysInTheDesign(t *testing.T) {
	f := makeFixture(t)
	f.open()
	f.agentCall(molten.MorphDesignAskCommand, molten.MorphDesignRequest{
		Mod: "branch-box", Key: "audience", Text: "Who?", Choices: []molten.MorphDesignChoice{{Label: "Just me"}},
	})
	f.b.setAgent(routetest.TerminalBlock, nil)
	d, errStr := f.windowCall(molten.MorphDesignChooseCommand, molten.MorphDesignRequest{Key: "audience", Value: "Just me"})
	if errStr != "" {
		t.Fatal(errStr)
	}
	if len(f.sender.messages()) != 0 || d.Told == nil || d.Told.Status != molten.MorphToldNoAgent || d.Questions[0].Answer != "Just me" || d.Agent != nil {
		t.Fatalf("no agent: %+v %+v messages %d", d.Told, d.Questions, len(f.sender.messages()))
	}
}

func TestAnAgentStartedInTheDesignTabsTerminalTakesTheClicks(t *testing.T) {
	f := makeFixture(t)
	opened := f.open()
	f.ask(f.e.Window(), molten.MorphDesignTabCommand, molten.MorphDesignRequest{Mod: "branch-box", Handoff: opened.HandoffId}, nil)
	f.b.setAgent(routetest.TerminalBlock, nil)
	f.b.setAgent("block-left", &fakeAgent{first: "Jérôme", agent: "codex"})
	d, errStr := f.windowCall(molten.MorphDesignStateCommand, molten.MorphDesignRequest{})
	if errStr != "" || d.Agent == nil || d.Agent.BlockId != "block-left" || !d.Agent.Here || d.Agent.FirstName != "Jérôme" {
		t.Fatalf("the receiver: %+v %s", d.Agent, errStr)
	}
	if _, errStr := f.windowCall(molten.MorphDesignDecideCommand, molten.MorphDesignRequest{Action: molten.MorphActionAgree}); errStr == "" {
		t.Fatal("agreeing to a plan that does not exist was accepted")
	}
	f.agentCall(molten.MorphDesignPlanCommand, molten.MorphDesignRequest{Mod: "branch-box", Plan: &molten.MorphDesignPlan{Summary: "A box."}})
	if _, errStr := f.windowCall(molten.MorphDesignDecideCommand, molten.MorphDesignRequest{Action: molten.MorphActionAgree}); errStr != "" {
		t.Fatal(errStr)
	}
	msgs := f.sender.messages()
	if len(msgs) != 1 || msgs[0].block != "block-left" || !strings.Contains(msgs[0].goal, "agreed to the plan") {
		t.Fatalf("the agreement went to %+v", msgs)
	}
}

func TestSkipsAndDecisionsTellTheAgentExceptTheOnesTheDeveloperWillSay(t *testing.T) {
	f := makeFixture(t)
	f.open()
	f.agentCall(molten.MorphDesignPlanCommand, molten.MorphDesignRequest{Mod: "branch-box", Plan: &molten.MorphDesignPlan{Summary: "A box."}})
	for _, c := range []struct {
		command string
		req     molten.MorphDesignRequest
		told    bool
		want    string
	}{
		{molten.MorphDesignSkipCommand, molten.MorphDesignRequest{Step: molten.MorphStepPreview, Action: molten.MorphActionSkip}, true, `skipped the step "preview"`},
		{molten.MorphDesignSkipCommand, molten.MorphDesignRequest{Step: molten.MorphStepPreview, Action: molten.MorphActionUnskip}, false, ""},
		{molten.MorphDesignSkipCommand, molten.MorphDesignRequest{Step: molten.MorphStepAdjust, Action: molten.MorphActionTerminal}, false, ""},
		{molten.MorphDesignDecideCommand, molten.MorphDesignRequest{Action: molten.MorphActionValidate}, true, "validated the mod"},
		{molten.MorphDesignDecideCommand, molten.MorphDesignRequest{Action: molten.MorphActionGiveUp}, true, "molten undo"},
	} {
		before := len(f.sender.messages())
		if _, errStr := f.windowCall(c.command, c.req); errStr != "" {
			t.Fatalf("%s %+v: %s", c.command, c.req, errStr)
		}
		msgs := f.sender.messages()
		if told := len(msgs) == before+1; told != c.told {
			t.Fatalf("%s %s: told = %v, want %v", c.command, c.req.Action, told, c.told)
		}
		if c.told && !strings.Contains(msgs[len(msgs)-1].goal, c.want) {
			t.Errorf("%s: the line lacks %q: %s", c.req.Action, c.want, msgs[len(msgs)-1].goal)
		}
	}
	if _, errStr := f.windowCall(molten.MorphDesignSkipCommand, molten.MorphDesignRequest{Step: "later", Action: molten.MorphActionSkip}); errStr == "" {
		t.Error("an unknown step was accepted")
	}
}

func TestAFailedSendIsNotTheDevelopersProblem(t *testing.T) {
	f := makeFixture(t)
	f.open()
	f.agentCall(molten.MorphDesignAskCommand, molten.MorphDesignRequest{
		Mod: "branch-box", Key: "audience", Text: "Who?", Choices: []molten.MorphDesignChoice{{Label: "Just me"}},
	})
	f.sender.err = errors.New("the agent's terminal could not be found")
	d, errStr := f.windowCall(molten.MorphDesignChooseCommand, molten.MorphDesignRequest{Key: "audience", Value: "Just me"})
	if errStr != "" || d.Questions[0].Answer != "Just me" || d.Told == nil || d.Told.Status != molten.MorphToldNoAgent {
		t.Fatalf("a failed send: %+v %+v %s", d.Questions, d.Told, errStr)
	}
}

// Another agent in another tab cannot rewrite a design an agent runs, nor take its clicks; an agent in the design's own tab
// can, and a design nobody runs is free to any agent.
func TestAnotherAgentElsewhereCannotChangeADesignAnAgentRuns(t *testing.T) {
	f := makeFixture(t)
	opened := f.open()
	f.ask(f.e.Window(), molten.MorphDesignTabCommand, molten.MorphDesignRequest{Mod: "branch-box", Handoff: opened.HandoffId}, nil)
	f.b.lock.Lock()
	f.b.tabOf["block-other"] = "tab-other"
	f.b.agents["block-other"] = fakeAgent{first: "Jérôme", agent: "codex"}
	f.b.lock.Unlock()
	other := localroute.Caller{IsLocalTerminal: true, BlockId: "block-other"}
	ctx := context.Background()

	for _, command := range []string{molten.MorphDesignStepCommand, molten.MorphDesignAskCommand, molten.MorphDesignAnswerCommand, molten.MorphDesignPlanCommand, molten.MorphDesignDraftCommand} {
		_, err := f.s.Handle(ctx, command, other, molten.MorphDesignRequest{
			Mod: "branch-box", Step: molten.MorphStepPlan, Key: "audience", Text: "Who?", Value: "x",
			Choices: []molten.MorphDesignChoice{{Label: "A"}}, Plan: &molten.MorphDesignPlan{Summary: "x"}, Draft: &molten.MorphDesignDraft{},
		})
		if err == nil || !strings.Contains(err.Error(), "is driven by Marion claude-code") {
			t.Errorf("%s from another agent: %v", command, err)
		}
	}
	d, _ := f.s.Store.Get("branch-box")
	if len(d.Questions) != 0 || d.Plan != nil || d.Current != molten.MorphStepNeed {
		t.Fatalf("a refused agent changed the design: %+v", d)
	}
	if _, err := f.s.Handle(ctx, molten.MorphDesignShowCommand, other, molten.MorphDesignRequest{Mod: "branch-box"}); err != nil {
		t.Fatalf("reading is open to every local terminal: %v", err)
	}
	if f.s.Store.Driver("branch-box") != routetest.TerminalBlock {
		t.Fatal("a refused agent, or one that only read, took the clicks")
	}
	if _, err := f.s.Handle(ctx, molten.MorphDesignOpenCommand, other, molten.MorphDesignRequest{Mod: "branch-box", Cwd: f.dir}); err != nil {
		t.Fatalf("opening again only shows the tab: %v", err)
	}
	if f.s.Store.Driver("branch-box") != routetest.TerminalBlock {
		t.Fatal("opening again took the clicks")
	}

	// An agent started in the design's own tab takes over.
	f.b.setAgent("block-left", &fakeAgent{first: "Léon", agent: "claude-code"})
	left := localroute.Caller{IsLocalTerminal: true, BlockId: "block-left"}
	if _, err := f.s.Handle(ctx, molten.MorphDesignStepCommand, left, molten.MorphDesignRequest{Mod: "branch-box", Step: molten.MorphStepPlan}); err != nil {
		t.Fatalf("an agent of the design's tab: %v", err)
	}
	if f.s.Store.Driver("branch-box") != "block-left" {
		t.Fatal("the agent of the design's tab drives now")
	}
	// Once nobody runs the design, any agent may take it.
	f.b.setAgent("block-left", nil)
	if _, err := f.s.Handle(ctx, molten.MorphDesignStepCommand, other, molten.MorphDesignRequest{Mod: "branch-box", Step: molten.MorphStepPreview}); err != nil {
		t.Fatalf("a design nobody runs: %v", err)
	}
	if f.s.Store.Driver("branch-box") != "block-other" {
		t.Fatal("the agent that changed a free design drives it")
	}
}

func TestAStateReadNeedsAnOpenDesign(t *testing.T) {
	f := makeFixture(t)
	if _, errStr := f.windowCall(molten.MorphDesignStateCommand, molten.MorphDesignRequest{}); !strings.Contains(errStr, "no design is open") {
		t.Fatalf("got %q", errStr)
	}
	if errStr := f.ask(f.e.Window(), molten.MorphDesignStateCommand, molten.MorphDesignRequest{}, nil); !strings.Contains(errStr, "mod is required") {
		t.Fatalf("a request with no mod: %q", errStr)
	}
}
