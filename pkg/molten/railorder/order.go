// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package railorder holds the order of the workspace rail (FR-MC-031, DS-MC-024): a list of workspace ids in the client
// meta "molten:workspaceorder". wavesrv is its only writer (pkg/wcore/moltenterm_workspaceorder.go); windows ask for a
// move through the route leaf "molten:railorder" (route.go). This file holds the pure rules.
package railorder

import (
	"fmt"
	"slices"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// must match frontend/moltenterm-shell/workspace-order.ts
const (
	MetaKey     = "molten:workspaceorder"
	RouteId     = "molten:railorder"
	MoveCommand = "railordermove"

	PlaceBefore = "before"
	PlaceAfter  = "after"
)

// MoveRequest puts a workspace next to a neighbour, never at a raw index: a rule on the pair (FR-MC-027's group rule:
// a member moves within its group, a product as a block) can then be checked before the move is written.
type MoveRequest struct {
	WorkspaceId string `json:"workspaceid"`
	TargetId    string `json:"targetid"`
	Place       string `json:"place"`
}

// ReadOrder reads the stored order; a missing or unreadable value is no order. The meta comes back from the database
// as []any, and as []string when it was just set in memory.
func ReadOrder(meta waveobj.MetaMapType) []string {
	raw, found := meta[MetaKey]
	if !found || raw == nil {
		return nil
	}
	switch v := raw.(type) {
	case []string:
		return slices.Clone(v)
	case []any:
		rtn := make([]string, 0, len(v))
		for _, item := range v {
			if id, ok := item.(string); ok && id != "" {
				rtn = append(rtn, id)
			}
		}
		return rtn
	}
	return nil
}

// ApplyOrder sorts the listed ids: the stored ones first, in the stored order, then the others in the listed (Wave's)
// order. Stored ids that are not listed (deleted workspaces) are dropped, so a deletion leaves no gap, and a new
// workspace, never stored, comes last.
func ApplyOrder(listed []string, stored []string) []string {
	present := make(map[string]bool, len(listed))
	for _, id := range listed {
		present[id] = true
	}
	rtn := make([]string, 0, len(listed))
	placed := make(map[string]bool, len(listed))
	for _, id := range stored {
		if !present[id] || placed[id] {
			continue
		}
		rtn = append(rtn, id)
		placed[id] = true
	}
	for _, id := range listed {
		if placed[id] {
			continue
		}
		rtn = append(rtn, id)
		placed[id] = true
	}
	return rtn
}

// Move returns the order with the workspace put before or after the target; changed is false when it already sits
// there.
func Move(order []string, req MoveRequest) (rtn []string, changed bool, err error) {
	if req.Place != PlaceBefore && req.Place != PlaceAfter {
		return nil, false, fmt.Errorf("unknown place %q: before or after", req.Place)
	}
	if req.WorkspaceId == "" || req.TargetId == "" {
		return nil, false, fmt.Errorf("a move needs a workspace and a neighbour")
	}
	if req.WorkspaceId == req.TargetId {
		return nil, false, fmt.Errorf("a workspace cannot move next to itself")
	}
	if !slices.Contains(order, req.WorkspaceId) {
		return nil, false, fmt.Errorf("workspace %q is not in the rail (an unsaved workspace cannot move)", req.WorkspaceId)
	}
	if !slices.Contains(order, req.TargetId) {
		return nil, false, fmt.Errorf("workspace %q is not in the rail", req.TargetId)
	}
	rtn = slices.DeleteFunc(slices.Clone(order), func(id string) bool { return id == req.WorkspaceId })
	at := slices.Index(rtn, req.TargetId)
	if req.Place == PlaceAfter {
		at++
	}
	rtn = slices.Insert(rtn, at, req.WorkspaceId)
	return rtn, !slices.Equal(rtn, order), nil
}

// MetaValue is the order as the client meta stores it.
func MetaValue(order []string) []any {
	rtn := make([]any, len(order))
	for i, id := range order {
		rtn[i] = id
	}
	return rtn
}
