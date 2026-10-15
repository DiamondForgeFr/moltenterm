// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

// The PR's state as GitHub has it (#686): the Review tab reads it when the PR leaves the Reviews list, to tell a PR
// merged or closed on GitHub, then shows the tab as done. One light gh pr view, nothing written.

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

const (
	PrStateCommand = "moltenreviewprstate"

	PrStateOpen   = "open"
	PrStateMerged = "merged"
	PrStateClosed = "closed"
)

const prStateFields = "number,state,mergedAt,closedAt,mergeCommit,baseRefName"

type PrStateRequest struct {
	Dir    string `json:"dir"`
	Repo   string `json:"repo"`
	Number int    `json:"number"`
}

// PrStateResult: State is PrStateOpen, PrStateMerged or PrStateClosed; the times are GitHub's (RFC 3339).
type PrStateResult struct {
	State     string `json:"state"`
	BaseRef   string `json:"baseref,omitempty"`
	MergedOid string `json:"mergedoid,omitempty"`
	MergedAt  string `json:"mergedat,omitempty"`
	ClosedAt  string `json:"closedat,omitempty"`
}

type ghPrState struct {
	Number      int    `json:"number"`
	State       string `json:"state"`
	MergedAt    string `json:"mergedAt"`
	ClosedAt    string `json:"closedAt"`
	BaseRefName string `json:"baseRefName"`
	MergeCommit *struct {
		Oid string `json:"oid"`
	} `json:"mergeCommit"`
}

func (m *Merger) PrState(ctx context.Context, req PrStateRequest) (PrStateResult, error) {
	if req.Repo == "" || req.Number <= 0 {
		return PrStateResult{}, fmt.Errorf("a repository and a pull request number are needed")
	}
	out, err := m.runGh(ctx, req.Dir, req.Repo, "pr", "view", strconv.Itoa(req.Number), "--json", prStateFields)
	if err != nil {
		return PrStateResult{}, err
	}
	var pr ghPrState
	if err := json.Unmarshal(out, &pr); err != nil {
		return PrStateResult{}, fmt.Errorf("gh pr view answered something unreadable: %v", err)
	}
	if pr.Number != req.Number {
		return PrStateResult{}, fmt.Errorf("gh pr view did not answer pull request #%d", req.Number)
	}
	rtn := PrStateResult{BaseRef: pr.BaseRefName}
	switch strings.ToUpper(pr.State) {
	case "MERGED":
		rtn.State = PrStateMerged
		rtn.MergedAt = pr.MergedAt
		if pr.MergeCommit != nil {
			rtn.MergedOid = pr.MergeCommit.Oid
		}
	case "CLOSED":
		rtn.State = PrStateClosed
		rtn.ClosedAt = pr.ClosedAt
	case "OPEN":
		rtn.State = PrStateOpen
	default:
		return PrStateResult{}, fmt.Errorf("gh pr view answered an unknown state %q", pr.State)
	}
	return rtn, nil
}
