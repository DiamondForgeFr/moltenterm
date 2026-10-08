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
	// Moves the whole product the workspace belongs to (FR-MC-027): its workspaces travel together.
	Block bool `json:"block,omitempty"`
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
	if err := checkRequest(order, req); err != nil {
		return nil, false, err
	}
	rtn = moveOne(order, req)
	return rtn, !slices.Equal(rtn, order), nil
}

func checkRequest(order []string, req MoveRequest) error {
	if req.Place != PlaceBefore && req.Place != PlaceAfter {
		return fmt.Errorf("unknown place %q: before or after", req.Place)
	}
	if req.WorkspaceId == "" || req.TargetId == "" {
		return fmt.Errorf("a move needs a workspace and a neighbour")
	}
	if req.WorkspaceId == req.TargetId {
		return fmt.Errorf("a workspace cannot move next to itself")
	}
	if !slices.Contains(order, req.WorkspaceId) {
		return fmt.Errorf("workspace %q is not in the rail (an unsaved workspace cannot move)", req.WorkspaceId)
	}
	if !slices.Contains(order, req.TargetId) {
		return fmt.Errorf("workspace %q is not in the rail", req.TargetId)
	}
	return nil
}

func moveOne(order []string, req MoveRequest) []string {
	rtn := slices.DeleteFunc(slices.Clone(order), func(id string) bool { return id == req.WorkspaceId })
	at := slices.Index(rtn, req.TargetId)
	if req.Place == PlaceAfter {
		at++
	}
	return slices.Insert(rtn, at, req.WorkspaceId)
}

// Normalize gathers each product's workspaces where its first one sits, in their order, the way the rail draws them
// (FR-MC-027). productOf maps a workspace id to its product's key; a workspace missing from it stands alone. The order
// stored before a project joined a group can hold a product's workspaces apart: the rail still shows them together.
func Normalize(order []string, productOf map[string]string) []string {
	if len(productOf) == 0 {
		return slices.Clone(order)
	}
	rtn := make([]string, 0, len(order))
	gathered := map[string]bool{}
	for _, id := range order {
		key := productOf[id]
		if key == "" {
			rtn = append(rtn, id)
			continue
		}
		if gathered[key] {
			continue
		}
		gathered[key] = true
		for _, other := range order {
			if productOf[other] == key {
				rtn = append(rtn, other)
			}
		}
	}
	return rtn
}

// productSpan returns where a product's workspaces start and end in a normalized order.
func productSpan(order []string, productOf map[string]string, key string) (first int, last int) {
	first, last = -1, -1
	for i, id := range order {
		if productOf[id] != key {
			continue
		}
		if first < 0 {
			first = i
		}
		last = i
	}
	return first, last
}

// checkEdge refuses a target inside another product: whatever lands next to a product lands before its first workspace
// or after its last one, never between two of its members.
func checkEdge(order []string, productOf map[string]string, req MoveRequest) error {
	key := productOf[req.TargetId]
	if key == "" {
		return nil
	}
	first, last := productSpan(order, productOf, key)
	at := slices.Index(order, req.TargetId)
	if (req.Place == PlaceBefore && at == first) || (req.Place == PlaceAfter && at == last) {
		return nil
	}
	return fmt.Errorf("the move would split the product %q: drop it before or after the product", key)
}

// MoveGrouped applies a move under the product rule of FR-MC-027 (DS-MC-024): a member of a product moves within its
// product only, a product moves as a block (req.Block), and nothing lands between two members of another product. The
// result is normalized, so a product's workspaces stay together in the stored order. Without products it is Move.
func MoveGrouped(order []string, productOf map[string]string, req MoveRequest) (rtn []string, changed bool, err error) {
	if err := checkRequest(order, req); err != nil {
		return nil, false, err
	}
	normal := Normalize(order, productOf)
	own := productOf[req.WorkspaceId]
	target := productOf[req.TargetId]
	switch {
	case req.Block:
		if own == "" {
			return nil, false, fmt.Errorf("workspace %q is in no product: move it alone", req.WorkspaceId)
		}
		if target == own {
			return nil, false, fmt.Errorf("a product cannot move next to one of its own members")
		}
		if err := checkEdge(normal, productOf, req); err != nil {
			return nil, false, err
		}
		block := []string{}
		rest := []string{}
		for _, id := range normal {
			if productOf[id] == own {
				block = append(block, id)
			} else {
				rest = append(rest, id)
			}
		}
		at := slices.Index(rest, req.TargetId)
		if req.Place == PlaceAfter {
			at++
		}
		rtn = slices.Insert(rest, at, block...)
	case own != "":
		if target != own {
			return nil, false, fmt.Errorf("a member of the product %q moves within its product only", own)
		}
		rtn = moveOne(normal, req)
	default:
		if err := checkEdge(normal, productOf, req); err != nil {
			return nil, false, err
		}
		rtn = moveOne(normal, req)
	}
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
