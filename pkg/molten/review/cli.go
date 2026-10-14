// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// `molten review` (FR-REV-014): the terminal reads the reviews and the review store, and hands the rest to the window.
// Opening a Review tab, its Publish sheet or its Validate sheet is a window's gesture: the terminal asks the window of
// its own workspace to make it (HandoffEvent), and GitHub still gets a review or a merge only on the developer's click
// in that sheet (DS-REV-011). A prompt in the terminal would not do: an agent can answer one.

const (
	// HandoffCommand: a local terminal asks its window to open a PR's Review tab, or one of its sheets.
	HandoffCommand = "moltenreviewhandoff"
	// MergePlanShownCommand reads the plan the window's Validate sheet holds, so the terminal prints the same one.
	MergePlanShownCommand = "moltenreviewmergeplanshown"
	// HandoffEvent goes to the window of the terminal's workspace (scope: the workspace id); must match
	// frontend/moltenterm-shell/reviews/reviews-handoff.ts.
	HandoffEvent = "molten:review:handoff"

	HandoffOpen    = "open"
	HandoffPublish = "publish"
	HandoffMerge   = "merge"
	// HandoffRestart opens Restart work's sheet (FR-REV-011): the round goes to an agent only on the sheet's click.
	HandoffRestart = "restart"
)

// ErrAgentTerminal is what publish, merge and restart answer to a terminal where an agent runs; the CLI prints it.
const ErrAgentTerminal = "this terminal runs an agent: publish, merge and restart are the developer's, from the Review tab of a MoltenTerm window"

type HandoffRequest struct {
	// Token: the terminal's WAVETERM_JWT, which names its block.
	Token  string `json:"token"`
	Action string `json:"action"`
	Dir    string `json:"dir"`
	Number int    `json:"number"`
}

type HandoffResult struct {
	WorkspaceId string `json:"workspaceid"`
	At          int64  `json:"at"`
}

// Handoff is what the window gets: it reads the PR from the Reviews data of Dir, as a row's click does.
type Handoff struct {
	Id     string `json:"id"`
	Action string `json:"action"`
	Dir    string `json:"dir"`
	Number int    `json:"number"`
	At     int64  `json:"at"`
}

// HandoffEnv is what a handoff needs from wavesrv; tests fake it.
type HandoffEnv struct {
	// VerifyToken returns the terminal block of a WAVETERM_JWT.
	VerifyToken  func(token string) (string, error)
	BlockIsLocal func(ctx context.Context, blockId string) bool
	// WorkspaceOf: the workspace holding the block's tab.
	WorkspaceOf func(ctx context.Context, blockId string) (string, error)
	// AgentRunning: MoltenTerm sees an agent running in the block (its state hooks).
	AgentRunning func(blockId string) bool
	Publish      func(workspaceId string, h Handoff)
	Now          func() time.Time
}

func handoffActionKnown(action string) bool {
	switch action {
	case HandoffOpen, HandoffPublish, HandoffMerge, HandoffRestart:
		return true
	}
	return false
}

// HandoffRefusedToAgents: publish, merge and restart are refused to a terminal where an agent runs (FR-REV-014 AC3). Opening a
// tab shows only what the developer already sees.
func HandoffRefusedToAgents(action string) bool {
	return action != HandoffOpen
}

// RunHandoff checks the terminal and the request, then asks the terminal's window to open the PR's tab or sheet.
func RunHandoff(ctx context.Context, env HandoffEnv, req HandoffRequest) (HandoffResult, error) {
	if !handoffActionKnown(req.Action) {
		return HandoffResult{}, fmt.Errorf("unknown review action %q", req.Action)
	}
	if err := checkDir(req.Dir); err != nil {
		return HandoffResult{}, err
	}
	if req.Number <= 0 {
		return HandoffResult{}, fmt.Errorf("number must be the PR's")
	}
	if req.Token == "" || env.VerifyToken == nil {
		return HandoffResult{}, errors.New("molten must run in a MoltenTerm terminal (WAVETERM_JWT is not set)")
	}
	blockId, err := env.VerifyToken(req.Token)
	if err != nil || blockId == "" {
		return HandoffResult{}, errors.New("this terminal's MoltenTerm token is not valid")
	}
	if env.BlockIsLocal == nil || !env.BlockIsLocal(ctx, blockId) {
		return HandoffResult{}, errors.New("review commands work from local MoltenTerm terminals only")
	}
	if HandoffRefusedToAgents(req.Action) && env.AgentRunning != nil && env.AgentRunning(blockId) {
		return HandoffResult{}, errors.New(ErrAgentTerminal)
	}
	workspaceId, err := env.WorkspaceOf(ctx, blockId)
	if err != nil || workspaceId == "" {
		return HandoffResult{}, errors.New("this terminal's window could not be found")
	}
	now := time.Now
	if env.Now != nil {
		now = env.Now
	}
	h := Handoff{Id: uuid.NewString(), Action: req.Action, Dir: req.Dir, Number: req.Number, At: now().UnixMilli()}
	env.Publish(workspaceId, h)
	return HandoffResult{WorkspaceId: workspaceId, At: h.At}, nil
}

// Shown returns the plan the window's Validate sheet holds for the PR, nil when it has none; the id a merge needs
// stays with the window.
func (m *Merger) Shown(k PrKey) (*MergePlan, error) {
	if err := k.check(); err != nil {
		return nil, err
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	plan, ok := m.plans[k]
	if !ok {
		return nil, nil
	}
	plan.Id = ""
	plan.ciNames = nil
	return &plan, nil
}
