// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"regexp"
	"slices"
)

// The mod design view (FR-MORPH-019, DS-MORPH-016): /morph opens a dedicated tab, the agent's terminal on the left and
// a guiding panel on the right. The agent drives the panel with `molten morph design`; wavesrv holds one design per
// mod (pkg/molten/morphdesign), and the panel only renders it and relays the developer's clicks. These names are
// shared with wsh and with the frontend (frontend/moltenterm-shell/morph-design).

// must match frontend/moltenterm-shell/morph-design/morph-design-model.ts
const (
	MorphDesignRoute = "molten:morphdesign"
	// MorphDesignEvent carries the whole design after each change, scoped to the mod id.
	MorphDesignEvent = "molten:morphdesign"
	// MorphDesignHandoffEvent goes to the window of the terminal's workspace (scope: the workspace id): open the tab.
	MorphDesignHandoffEvent = "molten:morphdesign:handoff"

	MorphDesignOpenCommand   = "moltenmorphdesignopen"
	MorphDesignShowCommand   = "moltenmorphdesignshow"
	MorphDesignStepCommand   = "moltenmorphdesignstep"
	MorphDesignAskCommand    = "moltenmorphdesignask"
	MorphDesignAnswerCommand = "moltenmorphdesignanswer"
	MorphDesignPlanCommand   = "moltenmorphdesignplan"
	MorphDesignDraftCommand  = "moltenmorphdesigndraft"

	MorphDesignTabCommand    = "moltenmorphdesigntab"
	MorphDesignStateCommand  = "moltenmorphdesignstate"
	MorphDesignChooseCommand = "moltenmorphdesignchoose"
	MorphDesignSkipCommand   = "moltenmorphdesignskip"
	MorphDesignDecideCommand = "moltenmorphdesigndecide"

	// The panel's steps, in order: the developer's need, a few questions, the plan, the live preview of the draft,
	// the adjustments, the name, icon and category, the validation, and the collection (Your mods).
	MorphStepNeed      = "need"
	MorphStepQuestions = "questions"
	MorphStepPlan      = "plan"
	MorphStepPreview   = "preview"
	MorphStepAdjust    = "adjust"
	MorphStepFinish    = "finish"
	MorphStepValidate  = "validate"
	MorphStepCollect   = "collect"

	MorphStepTodo    = "todo"
	MorphStepDone    = "done"
	MorphStepSkipped = "skipped"

	// Who did something in the design: the agent through `molten`, the developer in the panel, or the developer in the
	// terminal (told by the agent, or said in the panel).
	MorphByAgent    = "agent"
	MorphByPanel    = "panel"
	MorphByTerminal = "terminal"

	// A question's answers are labels to pick; an icon question's labels are Font Awesome names, drawn as icons.
	MorphKindChoice = "choice"
	MorphKindGlyphs = "icon"

	MorphDraftNone   = "none"
	MorphDraftSample = "sample"
	MorphDraftReal   = "real"

	// What the developer's click became: the agent's prompt got it (sent), typed without Enter (typed), waits for the
	// agent's prompt to be free (queued), or no agent could take it (noagent).
	MorphToldSent    = "sent"
	MorphToldTyped   = "typed"
	MorphToldQueued  = "queued"
	MorphToldNoAgent = "noagent"

	MorphActionAgree    = "agree"
	MorphActionValidate = "validate"
	MorphActionGiveUp   = "giveup"
	MorphActionSkip     = "skip"
	MorphActionUnskip   = "unskip"
	MorphActionTerminal = "terminal"

	MorphOutcomeValidated = "validated"
	MorphOutcomeGaveUp    = "gaveup"

	// Where the panel went: to the right of the terminal that asked, in its tab (agent left, graphics right), or, when
	// that cannot be done, in a dedicated tab with a terminal of its own.
	MorphPlacementPanel = "panel"
	MorphPlacementTab   = "tab"

	MorphHandoffTab   = "tab"
	MorphHandoffFocus = "focus"

	// MorphDesignMaxOpened is how many answered hand-offs a design remembers.
	MorphDesignMaxOpened = 8

	MorphDesignMaxQuestions = 20
	MorphDesignMaxChoices   = 8
	MorphDesignMaxItems     = 12
	MorphDesignMaxLabel     = 80
	MorphDesignMaxText      = 400
	MorphDesignMaxKey       = 64
	MorphDesignMaxDesigns   = 8
)

// MorphDesignSteps lists the steps in the order the panel shows them.
var MorphDesignSteps = []string{
	MorphStepNeed, MorphStepQuestions, MorphStepPlan, MorphStepPreview,
	MorphStepAdjust, MorphStepFinish, MorphStepValidate, MorphStepCollect,
}

// MorphModIdRegex is a mod id, as `molten mod new` takes it.
var MorphModIdRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// MorphKeyRegex is a question's key; the same shape as a learned item's key, so an answer is learned under it.
var MorphKeyRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// MorphIconRegex is a Font Awesome icon name.
var MorphIconRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,40}$`)

func MorphStepIndex(step string) int {
	return slices.Index(MorphDesignSteps, step)
}

type MorphDesignStep struct {
	Id    string `json:"id"`
	State string `json:"state"`
	By    string `json:"by,omitempty"`
	// Say: one plain sentence the agent shows under the step (the need reformulated, what it does now).
	Say string `json:"say,omitempty"`
}

type MorphDesignChoice struct {
	Label  string `json:"label"`
	Detail string `json:"detail,omitempty"`
}

type MorphDesignQuestion struct {
	Key  string `json:"key"`
	Step string `json:"step"`
	Text string `json:"text"`
	Kind string `json:"kind"`
	// Choices is empty for an answer given in the terminal to a question that was not asked in the panel.
	Choices     []MorphDesignChoice `json:"choices"`
	Recommended string              `json:"recommended,omitempty"`
	Answer      string              `json:"answer,omitempty"`
	AnsweredBy  string              `json:"answeredby,omitempty"`
}

type MorphDesignPlan struct {
	Summary    string   `json:"summary"`
	MoltenPart []string `json:"moltenpart"`
	AgentPart  []string `json:"agentpart"`
	Accesses   []string `json:"accesses"`
	Waits      []string `json:"waits"`
	Agreed     bool     `json:"agreed,omitempty"`
	AgreedBy   string   `json:"agreedby,omitempty"`
}

// MorphDesignDraft is what the preview shows until the declarative panel (FR-MORPH-020) draws the mod itself: the
// commands and boxes API version 1 draws.
type MorphDesignDraft struct {
	State    string   `json:"state"`
	Note     string   `json:"note,omitempty"`
	Commands []string `json:"commands"`
	Boxes    []string `json:"boxes"`
}

// MorphDesignAgent is the agent that receives what the developer decides in the panel.
type MorphDesignAgent struct {
	BlockId   string `json:"blockid"`
	FirstName string `json:"firstname,omitempty"`
	Agent     string `json:"agent,omitempty"`
	TabId     string `json:"tabid,omitempty"`
	// Here: the agent runs in this design's own tab.
	Here bool `json:"here,omitempty"`
}

// MorphDesignTold is what became of the developer's last click, for the panel to say.
type MorphDesignTold struct {
	Status string `json:"status"`
	To     string `json:"to,omitempty"`
	At     int64  `json:"at"`
}

type MorphDesign struct {
	Mod         string                `json:"mod"`
	Name        string                `json:"name,omitempty"`
	Dir         string                `json:"dir"`
	WorkspaceId string                `json:"workspaceid,omitempty"`
	TabId       string                `json:"tabid,omitempty"`
	Current     string                `json:"current"`
	Steps       []MorphDesignStep     `json:"steps"`
	Questions   []MorphDesignQuestion `json:"questions"`
	Plan        *MorphDesignPlan      `json:"plan,omitempty"`
	Draft       MorphDesignDraft      `json:"draft"`
	// Agent is who receives the clicks now: filled when the design is read, nil when no agent can take them.
	Agent   *MorphDesignAgent `json:"agent,omitempty"`
	Told    *MorphDesignTold  `json:"told,omitempty"`
	Outcome string            `json:"outcome,omitempty"`
	Updated int64             `json:"updated"`
	// Panel is the block of the design panel placed to the right of the agent's terminal, in that terminal's tab.
	Panel string `json:"panel,omitempty"`
	// Opened holds the last hand-offs the window answered, so `molten morph design` can tell its own was answered even
	// when another call's answer came after it.
	Opened []string `json:"opened,omitempty"`
	// Driver is the block of the agent that last ran a design command; the panel's clicks go to it first.
	Driver string `json:"-"`
}

// MorphDesignRequest is the data of every design command. Each command reads the fields it names.
type MorphDesignRequest struct {
	Mod  string `json:"mod,omitempty"`
	Name string `json:"name,omitempty"`
	// Cwd: the folder of the terminal that opens the design, where the tab's terminal starts.
	Cwd         string              `json:"cwd,omitempty"`
	TabName     string              `json:"tabname,omitempty"`
	Step        string              `json:"step,omitempty"`
	State       string              `json:"state,omitempty"`
	Say         string              `json:"say,omitempty"`
	Key         string              `json:"key,omitempty"`
	Text        string              `json:"text,omitempty"`
	Kind        string              `json:"kind,omitempty"`
	Choices     []MorphDesignChoice `json:"choices,omitempty"`
	Recommended string              `json:"recommended,omitempty"`
	Value       string              `json:"value,omitempty"`
	Plan        *MorphDesignPlan    `json:"plan,omitempty"`
	Draft       *MorphDesignDraft   `json:"draft,omitempty"`
	Action      string              `json:"action,omitempty"`
	Workspace   string              `json:"workspaceid,omitempty"`
	// Handoff: the hand-off a window's tab request answers.
	Handoff string `json:"handoffid,omitempty"`
}

// MorphDesignOpened answers `open`: the design, where its panel is, and for a dedicated tab the hand-off to wait for
// (the design's Opened tells it was answered).
type MorphDesignOpened struct {
	Design MorphDesign `json:"design"`
	// Placement: the panel beside the calling terminal, or a dedicated tab of its own.
	Placement string `json:"placement"`
	// Created: the panel or the tab was made by this call; false when it was there and is focused.
	Created bool `json:"created,omitempty"`
	// Fallback says why the panel could not go beside the terminal, when the design got a tab instead.
	Fallback  string `json:"fallback,omitempty"`
	HandoffId string `json:"handoffid,omitempty"`
}

// MorphDesignHandoff is the event a window gets: open the tab of a design (kind tab), or bring an open panel into view
// and give it the keyboard (kind focus, for a second call).
type MorphDesignHandoff struct {
	Id          string `json:"id"`
	Kind        string `json:"kind"`
	Mod         string `json:"mod"`
	Name        string `json:"name,omitempty"`
	Dir         string `json:"dir"`
	WorkspaceId string `json:"workspaceid"`
	// TabId and BlockId name the panel to focus.
	TabId   string `json:"tabid,omitempty"`
	BlockId string `json:"blockid,omitempty"`
	At      int64  `json:"at"`
}

// MorphDesignTabRequest is the window's request for the tab of a design.
type MorphDesignTabRequest struct {
	// HandoffId: the hand-off this request answers.
	HandoffId   string `json:"handoffid,omitempty"`
	WorkspaceId string `json:"workspaceid"`
	Mod         string `json:"mod"`
	Name        string `json:"name,omitempty"`
	Dir         string `json:"dir"`
	// TabName: the tab's name in the interface language; "Design · <mod>" when empty.
	TabName string `json:"tabname,omitempty"`
}

type MorphDesignTabResult struct {
	TabId   string `json:"tabid"`
	Created bool   `json:"created,omitempty"`
}
