// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/pipelinesetup"
)

// The pull request the release setup opened, followed from its step 3 (#1104, FR-MC-038): one gh pr view, nothing
// written. Its checks are folded as the Reviews list folds them.

const (
	SetupPrStatusOpen   = "open"
	SetupPrStatusMerged = "merged"
	SetupPrStatusClosed = "closed"

	setupPrStatusFields = "number,url,state,isDraft,headRefName,baseRefName,statusCheckRollup"
)

type SetupPrStatusRequest struct {
	Dir    string `json:"dir"`
	Number int    `json:"number"`
}

type SetupPrStatus struct {
	Number int    `json:"number"`
	Url    string `json:"url"`
	State  string `json:"state"`
	Draft  bool   `json:"draft"`
	Head   string `json:"head"`
	Base   string `json:"base"`
	// The checks' state (ReviewCheck*) and counts.
	Checks  string `json:"checks"`
	Success int    `json:"success"`
	Failure int    `json:"failure"`
	Pending int    `json:"pending"`
}

type ghSetupPr struct {
	Number            int              `json:"number"`
	Url               string           `json:"url"`
	State             string           `json:"state"`
	IsDraft           bool             `json:"isDraft"`
	HeadRefName       string           `json:"headRefName"`
	BaseRefName       string           `json:"baseRefName"`
	StatusCheckRollup []ghReviewRollup `json:"statusCheckRollup"`
}

// ReadSetupPrStatus reads the pull request's state through gh, in the project's folder.
func ReadSetupPrStatus(ctx context.Context, run pipelinesetup.Runner, req SetupPrStatusRequest) (SetupPrStatus, error) {
	if run == nil {
		return SetupPrStatus{}, fmt.Errorf("gh is not available")
	}
	if req.Dir == "" || !filepath.IsAbs(req.Dir) || req.Number <= 0 {
		return SetupPrStatus{}, fmt.Errorf("a project folder and a pull request number are needed")
	}
	out, err := run(ctx, filepath.Clean(req.Dir), "gh", "pr", "view", strconv.Itoa(req.Number), "--json", setupPrStatusFields)
	if err != nil {
		return SetupPrStatus{}, fmt.Errorf("gh pr view %d: %v", req.Number, err)
	}
	var pr ghSetupPr
	if err := json.Unmarshal(out, &pr); err != nil {
		return SetupPrStatus{}, fmt.Errorf("gh pr view answered something unreadable: %v", err)
	}
	if pr.Number != req.Number {
		return SetupPrStatus{}, fmt.Errorf("gh pr view did not answer pull request #%d", req.Number)
	}
	rtn := SetupPrStatus{Number: pr.Number, Url: pr.Url, Draft: pr.IsDraft, Head: pr.HeadRefName, Base: pr.BaseRefName}
	switch strings.ToUpper(pr.State) {
	case "MERGED":
		rtn.State = SetupPrStatusMerged
	case "CLOSED":
		rtn.State = SetupPrStatusClosed
	case "OPEN":
		rtn.State = SetupPrStatusOpen
	default:
		return SetupPrStatus{}, fmt.Errorf("gh pr view answered an unknown state %q", pr.State)
	}
	ci := SummarizeReviewChecks(pr.StatusCheckRollup)
	rtn.Checks, rtn.Success, rtn.Failure, rtn.Pending = ci.State, ci.Success, ci.Failure, ci.Pending
	return rtn, nil
}
