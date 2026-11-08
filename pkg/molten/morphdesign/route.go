// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package morphdesign

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agenthandoff"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// `molten morph design` and the design panel reach the design through a leaf of wavesrv's router answering plain
// command names, like `molten learn` (nothing is declared in pkg/wshrpc). The agent's commands are answered to local
// terminals, the panel's to windows only: an agent in a terminal never clicks for the developer. A remote host
// reaches nothing. The panel relays what the developer decides; it grants nothing.

const (
	dbTimeout   = 5 * time.Second
	sendTimeout = 20 * time.Second
	// The agent gets no outcome line to write: the answer to a click is the next step it shows in the panel.
	sendClosing = "No outcome line is needed. Show what comes next in the design panel with `molten morph design`, " +
		"and answer the developer in your terminal."
)

var agentCommands = []string{
	molten.MorphDesignOpenCommand, molten.MorphDesignShowCommand, molten.MorphDesignStepCommand,
	molten.MorphDesignAskCommand, molten.MorphDesignAnswerCommand, molten.MorphDesignPlanCommand,
	molten.MorphDesignDraftCommand,
}

var windowCommands = []string{
	molten.MorphDesignTabCommand, molten.MorphDesignStateCommand, molten.MorphDesignChooseCommand,
	molten.MorphDesignSkipCommand, molten.MorphDesignDecideCommand,
}

// Backend is what the design needs from wavesrv; tests fake it.
type Backend interface {
	// Locate returns the workspace and the tab holding a terminal block.
	Locate(blockId string) (workspaceId string, tabId string, err error)
	// DesignOfTab is the mod of a design tab, "" for any other tab.
	DesignOfTab(tabId string) string
	// TerminalsOfTab lists the terminal blocks of a tab.
	TerminalsOfTab(tabId string) []string
	// Agent says whether an agent runs in the terminal, and its first name and CLI.
	Agent(blockId string) (firstName string, agent string, running bool)
	OpenTab(req molten.MorphDesignTabRequest) (molten.MorphDesignTabResult, error)
	// PlacePanel adds the design's panel to the right of a terminal's block, in its tab; it returns the panel's block.
	PlacePanel(callerBlockId string, tabId string, target PanelTarget) (string, error)
	// BlockTab is the tab holding a block, false when the block is gone.
	BlockTab(blockId string) (string, bool)
	// PublishHandoff asks the window of a workspace to open a design's tab, or to focus its panel.
	PublishHandoff(workspaceId string, h molten.MorphDesignHandoff)
}

// SendResult is where a message to the agent went: delivered, typed without Enter, or queued, and to whom.
type SendResult struct {
	Status string
	To     string
}

// Sender types a message into an agent's prompt, MoltenTerm's own request way (#1143): the developer's click in the
// panel is its approval.
type Sender func(ctx context.Context, blockId string, goal string) (SendResult, error)

type Service struct {
	Store *Store
	B     Backend
	Send  Sender
	now   func() time.Time
}

func MakeService(store *Store, b Backend, send Sender) *Service {
	return &Service{Store: store, B: b, Send: send, now: time.Now}
}

func (s *Service) route() localroute.Route {
	policy := localroute.Policy{Default: localroute.AllowLocalTerminal, Commands: map[string]string{}, Refusals: map[string]string{}}
	for _, command := range windowCommands {
		policy.Commands[command] = localroute.AllowWindow
		policy.Refusals[command] = "the design panel is answered to a MoltenTerm window"
	}
	return localroute.Route{
		Id:     molten.MorphDesignRoute,
		Policy: policy,
		Handler: func(ctx context.Context, command string, caller localroute.Caller, data any) (any, error) {
			return s.Handle(ctx, command, caller, data)
		},
	}
}

func isAgentCommand(command string) bool {
	return utilfn.ContainsStr(agentCommands, command)
}

func (s *Service) Handle(ctx context.Context, command string, caller localroute.Caller, data any) (any, error) {
	var req molten.MorphDesignRequest
	if data != nil {
		if err := utilfn.ReUnmarshal(&req, data); err != nil {
			return nil, err
		}
	}
	if isAgentCommand(command) {
		if !caller.IsLocalTerminal || caller.BlockId == "" {
			return nil, fmt.Errorf("the design commands run in a MoltenTerm terminal of this computer")
		}
		return s.handleAgent(command, caller, req)
	}
	if !caller.IsWindow {
		return nil, fmt.Errorf("the design panel is answered to a MoltenTerm window")
	}
	return s.handleWindow(ctx, command, req)
}

// withAgent adds who receives the panel's clicks now.
func (s *Service) withAgent(d molten.MorphDesign) molten.MorphDesign {
	d.Agent = s.receiver(d)
	return d
}

// receiver is the agent the panel's clicks go to: the one that last drove the design, else one running in the design's
// own tab. Nil when none runs.
func (s *Service) receiver(d molten.MorphDesign) *molten.MorphDesignAgent {
	candidates := []string{}
	if d.Driver != "" {
		candidates = append(candidates, d.Driver)
	}
	if d.TabId != "" {
		candidates = append(candidates, s.B.TerminalsOfTab(d.TabId)...)
	}
	for _, blockId := range candidates {
		first, agent, running := s.B.Agent(blockId)
		if !running {
			continue
		}
		_, tabId, _ := s.B.Locate(blockId)
		return &molten.MorphDesignAgent{BlockId: blockId, FirstName: first, Agent: agent, TabId: tabId, Here: d.TabId != "" && tabId == d.TabId}
	}
	return nil
}

// resolveMod names the design a command is about: the one given, else the design of the caller's own tab, else the one
// the caller drives, else the only one open.
func (s *Service) resolveMod(caller localroute.Caller, given string) (string, error) {
	if given != "" {
		if _, ok := s.Store.Get(given); !ok {
			return "", fmt.Errorf("no design is open for the mod %q: open it with molten morph design %s", given, given)
		}
		return given, nil
	}
	mods := s.Store.Mods()
	if _, tabId, err := s.B.Locate(caller.BlockId); err == nil {
		if mod := s.B.DesignOfTab(tabId); mod != "" {
			if _, ok := s.Store.Get(mod); ok {
				return mod, nil
			}
		}
		// The panel placed beside this terminal is in this terminal's tab: the design of the tab, when only one is.
		inTab := []string{}
		for _, mod := range mods {
			if d, ok := s.Store.Get(mod); ok && d.TabId != "" && d.TabId == tabId {
				inTab = append(inTab, mod)
			}
		}
		if len(inTab) == 1 {
			return inTab[0], nil
		}
	}
	for _, mod := range mods {
		if s.Store.Driver(mod) == caller.BlockId {
			return mod, nil
		}
	}
	switch len(mods) {
	case 0:
		return "", fmt.Errorf("no design is open: open one with molten morph design <mod-id>")
	case 1:
		return mods[0], nil
	}
	return "", fmt.Errorf("several designs are open (%s): name one with --mod", strings.Join(mods, ", "))
}

// noteDriver makes the caller the agent the panel's clicks go to, when an agent runs there: a developer who types a
// design command by hand in the tab's terminal does not take the clicks from the agent.
func (s *Service) noteDriver(mod string, caller localroute.Caller) {
	if _, _, running := s.B.Agent(caller.BlockId); running {
		s.Store.SetDriver(mod, caller.BlockId)
	}
}

// mayChange tells whether the caller may change the design: nobody runs it, the caller does, or the caller is in the
// design's own tab. Another agent elsewhere never rewrites what the developer is looking at, nor takes their clicks.
func (s *Service) mayChange(mod string, caller localroute.Caller) error {
	d, ok := s.Store.Get(mod)
	if !ok || d.Driver == "" || d.Driver == caller.BlockId {
		return nil
	}
	first, agent, running := s.B.Agent(d.Driver)
	if !running {
		return nil
	}
	if d.TabId != "" {
		if _, tabId, err := s.B.Locate(caller.BlockId); err == nil && tabId == d.TabId {
			return nil
		}
	}
	return fmt.Errorf("the design of %q is driven by %s: only that agent, or a terminal of the design's own tab, changes it",
		mod, strings.TrimSpace(first+" "+agent))
}

func (s *Service) handleAgent(command string, caller localroute.Caller, req molten.MorphDesignRequest) (any, error) {
	if command == molten.MorphDesignOpenCommand {
		return s.open(caller, req)
	}
	mod, err := s.resolveMod(caller, req.Mod)
	if err != nil {
		return nil, err
	}
	changeErr := s.mayChange(mod, caller)
	if changeErr != nil && command != molten.MorphDesignShowCommand {
		return nil, changeErr
	}
	// Reading takes nothing: only a command that changes the design makes its agent the one the clicks go to.
	if changeErr == nil && command != molten.MorphDesignShowCommand {
		s.noteDriver(mod, caller)
	}
	var d molten.MorphDesign
	switch command {
	case molten.MorphDesignShowCommand:
		var ok bool
		if d, ok = s.Store.Get(mod); !ok {
			return nil, fmt.Errorf("no design is open for the mod %q", mod)
		}
	case molten.MorphDesignStepCommand:
		d, err = s.Store.SetStep(mod, req.Step, req.State, req.Say)
	case molten.MorphDesignAskCommand:
		d, err = s.Store.Ask(mod, molten.MorphDesignQuestion{
			Key: req.Key, Step: req.Step, Text: req.Text, Kind: req.Kind, Choices: req.Choices, Recommended: req.Recommended,
		})
	case molten.MorphDesignAnswerCommand:
		d, err = s.Store.Answer(mod, req.Key, req.Value, req.Text, req.Step)
	case molten.MorphDesignPlanCommand:
		if req.Plan == nil {
			return nil, fmt.Errorf("a plan needs its summary (--summary)")
		}
		d, err = s.Store.SetPlan(mod, *req.Plan)
	case molten.MorphDesignDraftCommand:
		if req.Draft == nil {
			return nil, fmt.Errorf("a draft needs its state (--state)")
		}
		d, err = s.Store.SetDraft(mod, *req.Draft)
	default:
		return nil, fmt.Errorf("unknown molten morph design command %q", command)
	}
	if err != nil {
		return nil, err
	}
	return s.withAgent(d), nil
}

// inUse tells whether something uses the design now: an agent drives it, its panel is open, or its tab is.
func (s *Service) inUse(d molten.MorphDesign) bool {
	if d.Driver != "" {
		if _, _, running := s.B.Agent(d.Driver); running {
			return true
		}
	}
	if d.Panel != "" {
		if _, ok := s.B.BlockTab(d.Panel); ok {
			return true
		}
	}
	return d.TabId != "" && d.Panel == "" && s.B.DesignOfTab(d.TabId) == d.Mod
}

func (s *Service) designsInUse() map[string]bool {
	inUse := map[string]bool{}
	for _, mod := range s.Store.Mods() {
		if d, ok := s.Store.Get(mod); ok && s.inUse(d) {
			inUse[mod] = true
		}
	}
	return inUse
}

// open makes the design and puts its panel to the right of the calling agent's terminal, in that terminal's own tab
// (agent left, graphics right): the live agent pane never moves. A second call focuses the panel. Only when the panel
// cannot go there does the design get a dedicated tab, which the window opens (`molten review open`'s pattern: opening
// a tab is the window's gesture); the answer then holds the hand-off id, which the design's Opened carries once the
// window answered, and says why. Another agent's design is never touched: the call is refused.
func (s *Service) open(caller localroute.Caller, req molten.MorphDesignRequest) (any, error) {
	if !molten.MorphModIdRegex.MatchString(req.Mod) {
		return nil, fmt.Errorf("invalid mod id %q: use lowercase letters, digits, \".\", \"_\" or \"-\", starting with a letter or digit", req.Mod)
	}
	dir := filepath.Clean(req.Cwd)
	if req.Cwd == "" || !filepath.IsAbs(dir) {
		return nil, fmt.Errorf("the terminal's folder must be an absolute path")
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("the terminal's folder %q does not exist", dir)
	}
	workspaceId, tabId, err := s.B.Locate(caller.BlockId)
	if err != nil || workspaceId == "" {
		return nil, fmt.Errorf("this terminal's window could not be found")
	}
	if err := s.mayChange(req.Mod, caller); err != nil {
		return nil, err
	}
	d, err := s.Store.Open(req.Mod, req.Name, dir, workspaceId, s.designsInUse())
	if err != nil {
		return nil, err
	}
	s.noteDriver(d.Mod, caller)
	d, _ = s.Store.Get(d.Mod)
	if opened, ok := s.focusExisting(d, workspaceId); ok {
		return opened, nil
	}
	fallback := "this terminal is in no tab"
	if tabId != "" {
		blockId, err := s.B.PlacePanel(caller.BlockId, tabId, PanelTarget{Mod: d.Mod, Name: d.Name, Dir: d.Dir, Term: caller.BlockId})
		if err == nil {
			if d, err = s.Store.SetPanel(d.Mod, blockId, tabId); err != nil {
				return nil, err
			}
			return molten.MorphDesignOpened{Design: s.withAgent(d), Placement: molten.MorphPlacementPanel, Created: true}, nil
		}
		log.Printf("molten morph design: no room for the panel beside the terminal: %v\n", err)
		fallback = err.Error()
	}
	return s.openTab(d, workspaceId, fallback), nil
}

// focusExisting handles a second call: the panel beside the agent's terminal, or the design's dedicated tab, is still
// open, and the window brings it into view.
func (s *Service) focusExisting(d molten.MorphDesign, workspaceId string) (molten.MorphDesignOpened, bool) {
	if d.Panel != "" {
		if panelTab, ok := s.B.BlockTab(d.Panel); ok {
			s.B.PublishHandoff(workspaceId, molten.MorphDesignHandoff{
				Id: uuid.NewString(), Kind: molten.MorphHandoffFocus, Mod: d.Mod, Name: d.Name, Dir: d.Dir, WorkspaceId: workspaceId,
				TabId: panelTab, BlockId: d.Panel, At: s.now().UnixMilli(),
			})
			return molten.MorphDesignOpened{Design: s.withAgent(d), Placement: molten.MorphPlacementPanel}, true
		}
	}
	if d.TabId != "" && d.Panel == "" && s.B.DesignOfTab(d.TabId) == d.Mod {
		return s.openTab(d, workspaceId, ""), true
	}
	return molten.MorphDesignOpened{}, false
}

func (s *Service) openTab(d molten.MorphDesign, workspaceId string, fallback string) molten.MorphDesignOpened {
	h := molten.MorphDesignHandoff{Id: uuid.NewString(), Kind: molten.MorphHandoffTab, Mod: d.Mod, Name: d.Name, Dir: d.Dir, WorkspaceId: workspaceId, At: s.now().UnixMilli()}
	s.B.PublishHandoff(workspaceId, h)
	return molten.MorphDesignOpened{Design: s.withAgent(d), Placement: molten.MorphPlacementTab, Fallback: fallback, HandoffId: h.Id}
}

func (s *Service) handleWindow(ctx context.Context, command string, req molten.MorphDesignRequest) (any, error) {
	if req.Mod == "" {
		return nil, fmt.Errorf("the mod is required")
	}
	switch command {
	case molten.MorphDesignStateCommand:
		d, ok := s.Store.Get(req.Mod)
		if !ok {
			return nil, fmt.Errorf("no design is open for the mod %q", req.Mod)
		}
		return s.withAgent(d), nil
	case molten.MorphDesignTabCommand:
		return s.tab(req)
	case molten.MorphDesignChooseCommand:
		d, err := s.Store.Choose(req.Mod, req.Key, req.Value)
		if err != nil {
			return nil, err
		}
		// Only what MoltenTerm itself knows goes in the line: the mod id, the question's key and the choice's number. The
		// question and the label are the agent's own words and stay out of a request MoltenTerm signs; the agent reads
		// the answer with `show`.
		choices := d.Questions[indexOfQuestion(d, req.Key)].Choices
		return s.tell(ctx, d, fmt.Sprintf(`In the mod design view of "%s", the developer picked choice %d of %d for the question with the key "%s". `+
			`Read their answer with molten morph design show, go on with the design and show the next step in the panel.`,
			d.Mod, choiceNumber(choices, req.Value), len(choices), req.Key)), nil
	case molten.MorphDesignSkipCommand:
		d, err := s.Store.SkipStep(req.Mod, req.Step, req.Action)
		if err != nil {
			return nil, err
		}
		if req.Action != molten.MorphActionSkip {
			return s.withAgent(d), nil
		}
		return s.tell(ctx, d, fmt.Sprintf(`In the mod design view of "%s", the developer skipped the step "%s". `+
			`Do not wait for it: go on with the next step.`, d.Mod, req.Step)), nil
	case molten.MorphDesignDecideCommand:
		return s.decide(ctx, req)
	}
	return nil, fmt.Errorf("unknown molten morph design command %q", command)
}

// choiceNumber is the 1-based place of a label among the choices.
func choiceNumber(choices []molten.MorphDesignChoice, label string) int {
	for i, c := range choices {
		if c.Label == label {
			return i + 1
		}
	}
	return 0
}

func indexOfQuestion(d molten.MorphDesign, key string) int {
	for i, q := range d.Questions {
		if q.Key == key {
			return i
		}
	}
	return 0
}

func (s *Service) tab(req molten.MorphDesignRequest) (any, error) {
	d, ok := s.Store.Get(req.Mod)
	if !ok {
		return nil, fmt.Errorf("no design is open for the mod %q", req.Mod)
	}
	workspaceId := req.Workspace
	if workspaceId == "" {
		workspaceId = d.WorkspaceId
	}
	tabReq := molten.MorphDesignTabRequest{
		HandoffId: req.Handoff, WorkspaceId: workspaceId, Mod: d.Mod, Name: d.Name, Dir: d.Dir, TabName: req.TabName,
	}
	result, err := s.B.OpenTab(tabReq)
	if err != nil {
		return nil, err
	}
	if _, err := s.Store.SetTab(d.Mod, result.TabId, req.Handoff); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) decide(ctx context.Context, req molten.MorphDesignRequest) (any, error) {
	d, err := s.Store.Decide(req.Mod, req.Action)
	if err != nil {
		return nil, err
	}
	var goal string
	switch req.Action {
	case molten.MorphActionAgree:
		goal = fmt.Sprintf(`In the mod design view of "%s", the developer agreed to the plan. Go on with step 4 of the /morph guide: `+
			`create the mod and ask for trust.`, d.Mod)
	case molten.MorphActionValidate:
		goal = fmt.Sprintf(`In the mod design view of "%s", the developer validated the mod. Close the design with steps 8 and 9 `+
			`of the /morph guide.`, d.Mod)
	default:
		goal = fmt.Sprintf(`In the mod design view of "%s", the developer gave the mod up. Run molten undo (step 8 of the /morph guide) `+
			`until the mod is gone, never further back than the change that created it, and say so.`, d.Mod)
	}
	return s.tell(ctx, d, goal), nil
}

// tell types the developer's decision into the receiving agent's prompt and records what became of it. With no agent
// to take it, the decision stays in the design, which `molten morph design show` gives to whichever agent comes.
func (s *Service) tell(ctx context.Context, d molten.MorphDesign, goal string) molten.MorphDesign {
	told := molten.MorphDesignTold{Status: molten.MorphToldNoAgent, At: s.now().UnixMilli()}
	if agent := s.receiver(d); agent != nil && s.Send != nil {
		sendCtx, cancel := context.WithTimeout(ctx, sendTimeout)
		defer cancel()
		if sent, err := s.Send(sendCtx, agent.BlockId, goal); err != nil {
			log.Printf("molten morph design: the message to %q was not sent: %v\n", agent.FirstName, err)
		} else {
			told.Status, told.To = sent.Status, sent.To
		}
	}
	if next, err := s.Store.SetTold(d.Mod, told); err == nil {
		d = next
	}
	return s.withAgent(d)
}

type liveBackend struct{}

func dbCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), dbTimeout)
}

func (liveBackend) Locate(blockId string) (string, string, error) {
	ctx, cancel := dbCtx()
	defer cancel()
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil || tabId == "" {
		return "", "", fmt.Errorf("this terminal is in no tab")
	}
	workspaceId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId)
	if err != nil {
		return "", tabId, err
	}
	return workspaceId, tabId, nil
}

func (liveBackend) DesignOfTab(tabId string) string {
	ctx, cancel := dbCtx()
	defer cancel()
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if err != nil || tab == nil {
		return ""
	}
	return tab.Meta.GetString(TabMetaKey, "")
}

func (liveBackend) TerminalsOfTab(tabId string) []string {
	ctx, cancel := dbCtx()
	defer cancel()
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if err != nil || tab == nil {
		return nil
	}
	terminals := []string{}
	for _, blockId := range tab.BlockIds {
		block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
		if err == nil && block != nil && block.Meta.GetString(waveobj.MetaKey_View, "") == "term" {
			terminals = append(terminals, blockId)
		}
	}
	return terminals
}

func (liveBackend) Agent(blockId string) (string, string, bool) {
	run, ok := attention.AgentRun(blockId)
	if !ok || !run.Running {
		return "", "", false
	}
	return run.FirstName, run.Agent, true
}

func (liveBackend) OpenTab(req molten.MorphDesignTabRequest) (molten.MorphDesignTabResult, error) {
	return openTab(req)
}

func (liveBackend) PlacePanel(callerBlockId string, tabId string, target PanelTarget) (string, error) {
	return placePanel(callerBlockId, tabId, target)
}

func (liveBackend) BlockTab(blockId string) (string, bool) {
	ctx, cancel := dbCtx()
	defer cancel()
	block, err := wstore.DBGet[*waveobj.Block](ctx, blockId)
	if err != nil || block == nil {
		return "", false
	}
	tabId, err := wstore.DBFindTabForBlockId(ctx, blockId)
	if err != nil || tabId == "" {
		return "", false
	}
	return tabId, true
}

func (liveBackend) PublishHandoff(workspaceId string, h molten.MorphDesignHandoff) {
	wps.Broker.Publish(wps.WaveEvent{Event: molten.MorphDesignHandoffEvent, Scopes: []string{workspaceId}, Data: h})
}

func liveSender(ctx context.Context, blockId string, goal string) (SendResult, error) {
	sent, err := agenthandoff.SendFromApp(ctx, agenthandoff.AppRequest{ToBlockId: blockId, Goal: goal, Closing: sendClosing})
	if err != nil {
		return SendResult{}, err
	}
	status := molten.MorphToldQueued
	switch sent.Status {
	case agenthandoff.StatusDelivered:
		status = molten.MorphToldSent
	case agenthandoff.StatusTyped:
		status = molten.MorphToldTyped
	}
	return SendResult{Status: status, To: sent.To}, nil
}

// StartRoute registers the route; wavesrv calls it once.
func StartRoute() {
	var service *Service
	store := MakeStore(func(d molten.MorphDesign) {
		wps.Broker.Publish(wps.WaveEvent{Event: molten.MorphDesignEvent, Scopes: []string{d.Mod}, Data: service.withAgent(d)})
	})
	service = MakeService(store, liveBackend{}, liveSender)
	if _, err := localroute.Register(wshutil.DefaultRouter, service.route()); err != nil {
		log.Printf("molten: morph design route not started: %v\n", err)
	}
}
