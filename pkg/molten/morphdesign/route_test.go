// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package morphdesign

import (
	"context"
	"errors"
	"fmt"
	"slices"
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

type placeCall struct {
	caller string
	tab    string
	target PanelTarget
}

// fakeBackend is a workspace with an agent's terminal in tab-chat, where the panel is placed, and a dedicated tab,
// tab-design, for the fallback; panels are blocks of the blocks map until a test takes them away.
type fakeBackend struct {
	lock       sync.Mutex
	tabOf      map[string]string
	designTabs map[string]string
	terminals  map[string][]string
	agents     map[string]fakeAgent
	blocks     map[string]string
	placed     []placeCall
	placeErr   error
	opened     []molten.MorphDesignTabRequest
	handoffs   []molten.MorphDesignHandoff
}

func makeFakeBackend() *fakeBackend {
	return &fakeBackend{
		tabOf:      map[string]string{routetest.TerminalBlock: "tab-chat", "block-left": "tab-design"},
		designTabs: map[string]string{"tab-design": "branch-box"},
		terminals:  map[string][]string{"tab-design": {"block-left"}},
		agents:     map[string]fakeAgent{routetest.TerminalBlock: {first: "Marion", agent: "claude-code"}},
		blocks:     map[string]string{},
	}
}

func (b *fakeBackend) PlacePanel(callerBlockId string, tabId string, target PanelTarget) (string, error) {
	b.lock.Lock()
	defer b.lock.Unlock()
	if b.placeErr != nil {
		return "", b.placeErr
	}
	b.placed = append(b.placed, placeCall{callerBlockId, tabId, target})
	id := fmt.Sprintf("panel-%d", len(b.placed))
	b.blocks[id] = tabId
	return id, nil
}

func (b *fakeBackend) BlockTab(blockId string) (string, bool) {
	b.lock.Lock()
	defer b.lock.Unlock()
	tab, ok := b.blocks[blockId]
	return tab, ok
}

func (b *fakeBackend) closePanel(blockId string) {
	b.lock.Lock()
	defer b.lock.Unlock()
	delete(b.blocks, blockId)
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

// Agent left, graphics right: the panel goes to the right of the calling terminal, in its own tab; nothing moves and no
// window has to answer.
func TestOpenPlacesThePanelBesideTheCallingTerminal(t *testing.T) {
	f := makeFixture(t)
	opened := f.open()
	if len(f.b.placed) != 1 {
		t.Fatalf("%d panels placed", len(f.b.placed))
	}
	if p := f.b.placed[0]; p.caller != routetest.TerminalBlock || p.tab != "tab-chat" ||
		p.target != (PanelTarget{Mod: "branch-box", Name: "Branch box", Dir: f.dir, Term: routetest.TerminalBlock}) {
		t.Fatalf("the panel: %+v", p)
	}
	if opened.Placement != molten.MorphPlacementPanel || !opened.Created || opened.HandoffId != "" || opened.Fallback != "" {
		t.Fatalf("the answer: %+v", opened)
	}
	if len(f.b.handoffs) != 0 || len(f.b.opened) != 0 {
		t.Fatalf("a panel beside the terminal asks no window to open a tab: %+v %+v", f.b.handoffs, f.b.opened)
	}
	d := opened.Design
	if d.Panel != "panel-1" || d.TabId != "tab-chat" {
		t.Fatalf("the design knows its panel: %+v", d)
	}
	if d.Agent == nil || d.Agent.FirstName != "Marion" || !d.Agent.Here {
		t.Fatalf("the agent that opened it receives the clicks, in the terminal beside the panel: %+v", d.Agent)
	}
}

// A second call focuses the panel it already has; once the developer closed it, the next call places a new one.
func TestASecondOpenFocusesThePanelAndAClosedOneIsPlacedAgain(t *testing.T) {
	f := makeFixture(t)
	f.open()
	second := f.open()
	if len(f.b.placed) != 1 || second.Created || second.Placement != molten.MorphPlacementPanel || second.HandoffId != "" {
		t.Fatalf("a second call placed %d panels: %+v", len(f.b.placed), second)
	}
	if len(f.b.handoffs) != 1 {
		t.Fatalf("%d hand-offs", len(f.b.handoffs))
	}
	if h := f.b.handoffs[0]; h.Kind != molten.MorphHandoffFocus || h.TabId != "tab-chat" || h.BlockId != "panel-1" || h.WorkspaceId != "ws-1" || h.Mod != "branch-box" {
		t.Fatalf("the window is asked to focus the panel: %+v", h)
	}
	f.b.closePanel("panel-1")
	third := f.open()
	if !third.Created || len(f.b.placed) != 2 || third.Design.Panel != "panel-2" {
		t.Fatalf("a closed panel is placed again: %+v (%d placed)", third, len(f.b.placed))
	}
}

// When the panel cannot go beside the terminal, the design gets its own tab as before, and the answer says why.
func TestOpenFallsBackToADedicatedTabAndSaysWhy(t *testing.T) {
	f := makeFixture(t)
	f.b.placeErr = errors.New("the layout has no room")
	opened := f.open()
	if opened.Placement != molten.MorphPlacementTab || opened.Created || !strings.Contains(opened.Fallback, "the layout has no room") || opened.HandoffId == "" {
		t.Fatalf("the answer: %+v", opened)
	}
	if len(f.b.handoffs) != 1 {
		t.Fatalf("%d hand-offs", len(f.b.handoffs))
	}
	h := f.b.handoffs[0]
	if h.Kind != molten.MorphHandoffTab || h.Id != opened.HandoffId || h.WorkspaceId != "ws-1" || h.Mod != "branch-box" || h.Dir != f.dir || h.Name != "Branch box" {
		t.Fatalf("the hand-off: %+v for %+v", h, opened)
	}
	if len(opened.Design.Opened) != 0 || opened.Design.TabId != "" || opened.Design.Panel != "" {
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
	if len(f.b.handoffs) != 0 || len(f.b.placed) != 0 {
		t.Fatal("a refused open placed a panel or asked the window")
	}
}

func TestTheWindowMakesTheTabAndTheDesignRemembersIt(t *testing.T) {
	f := makeFixture(t)
	f.b.placeErr = errors.New("no room")
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
	if d.TabId != "tab-design" || !slices.Contains(d.Opened, opened.HandoffId) {
		t.Fatalf("the design must say the window answered this hand-off: %+v", d)
	}
}

// Two calls open at once: the window's answers come in any order, and each call still finds its own.
func TestOverlappingOpensEachFindTheirOwnAnswer(t *testing.T) {
	f := makeFixture(t)
	f.b.placeErr = errors.New("no room")
	first := f.open()
	second := f.open()
	if first.HandoffId == "" || second.HandoffId == "" || first.HandoffId == second.HandoffId {
		t.Fatalf("two hand-offs: %+v %+v", first, second)
	}
	for _, id := range []string{second.HandoffId, first.HandoffId} {
		if errStr := f.ask(f.e.Window(), molten.MorphDesignTabCommand, molten.MorphDesignRequest{Mod: "branch-box", Handoff: id}, nil); errStr != "" {
			t.Fatal(errStr)
		}
	}
	d := f.agentCall(molten.MorphDesignShowCommand, molten.MorphDesignRequest{Mod: "branch-box"})
	if !slices.Contains(d.Opened, first.HandoffId) || !slices.Contains(d.Opened, second.HandoffId) {
		t.Fatalf("an answer that came before another is lost: %v", d.Opened)
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
	for _, want := range []string{`"branch-box"`, `choice 2 of 2`, `"audience"`, "molten morph design show"} {
		if !strings.Contains(msgs[0].goal, want) {
			t.Errorf("the line lacks %q: %s", want, msgs[0].goal)
		}
	}
	// MoltenTerm signs this request: the agent's own words (the question, the label) are not in it.
	for _, notWant := range []string{"My team", "Just me", "Who will use it?"} {
		if strings.Contains(msgs[0].goal, notWant) {
			t.Errorf("the agent's own words %q reached a line MoltenTerm signs: %s", notWant, msgs[0].goal)
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
	f.b.placeErr = errors.New("no room")
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
	f.open()
	f.b.lock.Lock()
	f.b.tabOf["block-other"] = "tab-other"
	f.b.agents["block-other"] = fakeAgent{first: "Jérôme", agent: "codex"}
	f.b.tabOf["block-sibling"] = "tab-chat"
	f.b.lock.Unlock()
	other := localroute.Caller{IsLocalTerminal: true, BlockId: "block-other"}
	ctx := context.Background()
	before, _ := f.s.Store.Get("branch-box")

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
	// Opening again is a change too: refused, and nothing of the design moves (its name, folder, workspace, tab, panel
	// and driver stay what the agent that runs it made them).
	_, err := f.s.Handle(ctx, molten.MorphDesignOpenCommand, other, molten.MorphDesignRequest{Mod: "branch-box", Name: "Another name", Cwd: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "is driven by Marion claude-code") {
		t.Fatalf("opening again from another agent: %v", err)
	}
	after, _ := f.s.Store.Get("branch-box")
	if after.Name != before.Name || after.Dir != before.Dir || after.WorkspaceId != before.WorkspaceId || after.TabId != before.TabId ||
		after.Panel != before.Panel || after.Driver != before.Driver || !slices.Equal(after.Opened, before.Opened) {
		t.Fatalf("a refused open changed the design: %+v, was %+v", after, before)
	}
	if len(f.b.placed) != 1 || len(f.b.handoffs) != 0 {
		t.Fatalf("a refused open placed a panel or asked the window: %d placed, %+v", len(f.b.placed), f.b.handoffs)
	}

	// An agent started in the design's own tab takes over, but only by a command that changes the design.
	f.b.setAgent("block-sibling", &fakeAgent{first: "Léon", agent: "claude-code"})
	sibling := localroute.Caller{IsLocalTerminal: true, BlockId: "block-sibling"}
	if _, err := f.s.Handle(ctx, molten.MorphDesignShowCommand, sibling, molten.MorphDesignRequest{Mod: "branch-box"}); err != nil {
		t.Fatal(err)
	}
	if f.s.Store.Driver("branch-box") != routetest.TerminalBlock {
		t.Fatal("reading with show took the clicks")
	}
	if _, err := f.s.Handle(ctx, molten.MorphDesignStepCommand, sibling, molten.MorphDesignRequest{Mod: "branch-box", Step: molten.MorphStepPlan}); err != nil {
		t.Fatalf("an agent of the design's tab: %v", err)
	}
	if f.s.Store.Driver("branch-box") != "block-sibling" {
		t.Fatal("the agent of the design's tab drives now")
	}
	// Once nobody runs the design, any agent may take it.
	f.b.setAgent("block-sibling", nil)
	f.b.setAgent(routetest.TerminalBlock, nil)
	if _, err := f.s.Handle(ctx, molten.MorphDesignStepCommand, other, molten.MorphDesignRequest{Mod: "branch-box", Step: molten.MorphStepPreview}); err != nil {
		t.Fatalf("a design nobody runs: %v", err)
	}
	if f.s.Store.Driver("branch-box") != "block-other" {
		t.Fatal("the agent that changed a free design drives it")
	}
}

// Eight live designs make a ninth refused, with the way out in the message; a design whose agent left and whose panel was
// closed is the one dropped.
func TestAnOpenDesignIsNotEvictedForANewOne(t *testing.T) {
	f := makeFixture(t)
	open := func(mod string) (molten.MorphDesignOpened, string) {
		var opened molten.MorphDesignOpened
		errStr := f.ask(f.e.Terminal(), molten.MorphDesignOpenCommand, molten.MorphDesignRequest{Mod: mod, Cwd: f.dir}, &opened)
		return opened, errStr
	}
	for i := 0; i < molten.MorphDesignMaxDesigns; i++ {
		if _, errStr := open(fmt.Sprintf("d%d", i)); errStr != "" {
			t.Fatalf("design %d: %s", i, errStr)
		}
	}
	if _, errStr := open("d8"); !strings.Contains(errStr, "are open and in use") {
		t.Fatalf("a ninth live design: %q", errStr)
	}
	if len(f.s.Store.Mods()) != molten.MorphDesignMaxDesigns {
		t.Fatalf("a refused design dropped another: %v", f.s.Store.Mods())
	}
	f.b.setAgent(routetest.TerminalBlock, nil)
	f.b.closePanel("panel-4")
	if _, errStr := open("d8"); errStr != "" {
		t.Fatalf("a design nothing uses makes room: %s", errStr)
	}
	if _, ok := f.s.Store.Get("d3"); ok {
		t.Error("the design nothing used stayed")
	}
	if _, ok := f.s.Store.Get("d0"); !ok {
		t.Error("a design with its panel open was dropped")
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
