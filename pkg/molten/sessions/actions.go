// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Ops are the changes the actions make, wavesrv's in the app (ops.go), recorded in tests.
type Ops interface {
	// TerminateJob ends a job (its pane, if any, stays as an ended terminal).
	TerminateJob(ctx context.Context, jobId string) error
	// TerminateAndDetachJob ends a job no pane shows and forgets its pane link.
	TerminateAndDetachJob(ctx context.Context, jobId string) error
	// DetachJob drops a job's link to a pane that is gone or holds another job (the pane is left as it is).
	DetachJob(ctx context.Context, jobId string) error
	// CreatePane makes a terminal block in tabId for the session, not yet in the layout.
	CreatePane(ctx context.Context, tabId string, session molten.DurableSession) (string, error)
	// CopyHistory copies the tail of the job's output into the block, so the new pane shows what ran.
	CopyHistory(ctx context.Context, jobId string, blockId string) error
	AttachJob(ctx context.Context, jobId string, blockId string) error
	// InsertPane puts the block in the tab's layout, focused.
	InsertPane(ctx context.Context, tabId string, blockId string) error
	WorkspaceOfTab(ctx context.Context, tabId string) (string, error)
	ActiveTab(ctx context.Context, workspaceId string) (string, error)
	SetActiveTab(ctx context.Context, workspaceId string, tabId string) error
	// FocusBlock asks the tab's renderer to focus the block once it shows the tab (molten:focusblock).
	FocusBlock(ctx context.Context, tabId string, blockId string) error
	ConnectHost(ctx context.Context, connection string) error
	ReconnectJob(ctx context.Context, jobId string) error
}

// Actions are what the user does with a session; each re-reads the list first, then rebuilds it.
type Actions struct {
	model *Model
	ops   Ops
}

func MakeActions(model *Model, ops Ops) *Actions {
	return &Actions{model: model, ops: ops}
}

// fresh reads the list again: an action never acts on what a window showed a while ago.
func (a *Actions) fresh(id string) (molten.DurableSession, bool, error) {
	data, err := a.model.Rebuild()
	if err != nil {
		return molten.DurableSession{}, false, err
	}
	for _, s := range data.Sessions {
		if s.Id == id {
			return s, true, nil
		}
	}
	return molten.DurableSession{}, false, nil
}

func (a *Actions) find(id string) (molten.DurableSession, error) {
	if id == "" {
		return molten.DurableSession{}, fmt.Errorf("no session id given")
	}
	s, ok, err := a.fresh(id)
	if err != nil {
		return s, err
	}
	if !ok {
		return s, fmt.Errorf("the session %s is no longer running", molten.ShortSessionId(id))
	}
	return s, nil
}

func (a *Actions) rebuild() {
	a.model.rebuildLogged()
}

// End ends a session. The terminal asking cannot end its own session (`molten session end` from inside it).
func (a *Actions) End(ctx context.Context, id string, callerBlockId string) (molten.DurableSessionEndResult, error) {
	s, err := a.find(id)
	if err != nil {
		return molten.DurableSessionEndResult{}, err
	}
	if callerBlockId != "" && s.BlockId == callerBlockId {
		return molten.DurableSessionEndResult{}, fmt.Errorf("a session cannot end itself: type exit instead")
	}
	defer a.rebuild()
	return a.end(ctx, s)
}

func (a *Actions) end(ctx context.Context, s molten.DurableSession) (molten.DurableSessionEndResult, error) {
	if s.Shown {
		err := a.ops.TerminateJob(ctx, s.Id)
		if err != nil && s.Connection != "" {
			// The host is unreachable: the job ends when it is back (TerminateOnReconnect).
			return molten.DurableSessionEndResult{Pending: true}, nil
		}
		return molten.DurableSessionEndResult{}, err
	}
	err := a.ops.TerminateAndDetachJob(ctx, s.Id)
	if err != nil && s.Connection != "" {
		return molten.DurableSessionEndResult{Pending: true}, nil
	}
	return molten.DurableSessionEndResult{}, err
}

// Cleanup ends the sessions no pane shows among ids. Each is checked again: one shown in a pane since the list was
// on screen, or already gone, is skipped, never ended.
func (a *Actions) Cleanup(ctx context.Context, ids []string) (molten.DurableSessionsCleanupResult, error) {
	rtn := molten.DurableSessionsCleanupResult{Ended: []string{}, Skipped: []string{}}
	data, err := a.model.Rebuild()
	if err != nil {
		return rtn, err
	}
	byId := map[string]molten.DurableSession{}
	for _, s := range data.Sessions {
		byId[s.Id] = s
	}
	defer a.rebuild()
	for _, id := range ids {
		s, ok := byId[id]
		if !ok || s.Shown || !s.CanEnd {
			rtn.Skipped = append(rtn.Skipped, id)
			continue
		}
		res, err := a.end(ctx, s)
		if err != nil || res.Pending {
			rtn.Failed = append(rtn.Failed, id)
			continue
		}
		rtn.Ended = append(rtn.Ended, id)
	}
	return rtn, nil
}

// Show brings a session on screen. One in a pane: its tab is made active in its workspace when the caller is in
// another workspace (the window then switches to it), and the tab's renderer focuses the pane. One no pane shows is
// reattached into a new pane of tabId, with its history.
func (a *Actions) Show(ctx context.Context, id string, tabId string) (molten.SessionLocation, error) {
	s, err := a.find(id)
	if err != nil {
		return molten.SessionLocation{}, err
	}
	if !s.CanShow {
		return molten.SessionLocation{}, fmt.Errorf("this session cannot be shown: %s", reasonText(s.Reason))
	}
	if s.Shown {
		return a.showShown(ctx, s, tabId)
	}
	return a.reattach(ctx, s, tabId)
}

func reasonText(reason string) string {
	switch reason {
	case molten.SessionReasonOlderVersion:
		return "it was started by an older MoltenTerm and can only be ended"
	case molten.SessionReasonEnding:
		return "it is being ended"
	}
	return reason
}

func (a *Actions) showShown(ctx context.Context, s molten.DurableSession, callerTabId string) (molten.SessionLocation, error) {
	loc := molten.SessionLocation{WorkspaceId: s.WorkspaceId, TabId: s.TabId, BlockId: s.BlockId}
	callerWs := ""
	if callerTabId != "" {
		callerWs, _ = a.ops.WorkspaceOfTab(ctx, callerTabId)
	}
	// The caller's own workspace switches tab from its window (Wave's tab switch); another workspace shows its
	// active tab when the window switches to it, so that tab is set here.
	if callerWs != s.WorkspaceId {
		active, err := a.ops.ActiveTab(ctx, s.WorkspaceId)
		if err == nil && active != s.TabId {
			if err := a.ops.SetActiveTab(ctx, s.WorkspaceId, s.TabId); err != nil {
				return loc, err
			}
		}
	}
	if err := a.ops.FocusBlock(ctx, s.TabId, s.BlockId); err != nil {
		return loc, err
	}
	return loc, nil
}

func (a *Actions) reattach(ctx context.Context, s molten.DurableSession, tabId string) (molten.SessionLocation, error) {
	if tabId == "" {
		return molten.SessionLocation{}, fmt.Errorf("no tab to open the session in")
	}
	wsId, err := a.ops.WorkspaceOfTab(ctx, tabId)
	if err != nil {
		return molten.SessionLocation{}, err
	}
	defer a.rebuild()
	if s.Reason == molten.SessionReasonPaneGone || s.Reason == molten.SessionReasonReplaced {
		if err := a.ops.DetachJob(ctx, s.Id); err != nil {
			return molten.SessionLocation{}, err
		}
	}
	blockId, err := a.ops.CreatePane(ctx, tabId, s)
	if err != nil {
		return molten.SessionLocation{}, err
	}
	if err := a.ops.CopyHistory(ctx, s.Id, blockId); err != nil {
		return molten.SessionLocation{}, err
	}
	if err := a.ops.AttachJob(ctx, s.Id, blockId); err != nil {
		return molten.SessionLocation{}, err
	}
	if err := a.ops.InsertPane(ctx, tabId, blockId); err != nil {
		return molten.SessionLocation{}, err
	}
	return molten.SessionLocation{WorkspaceId: wsId, TabId: tabId, BlockId: blockId, Created: true}, nil
}

// Reconnect connects the session's host (Wave's usual prompts apply), then the job.
func (a *Actions) Reconnect(ctx context.Context, id string) error {
	s, err := a.find(id)
	if err != nil {
		return err
	}
	defer a.rebuild()
	if s.Connection != "" {
		if err := a.ops.ConnectHost(ctx, s.Connection); err != nil {
			return err
		}
	}
	return a.ops.ReconnectJob(ctx, s.Id)
}
