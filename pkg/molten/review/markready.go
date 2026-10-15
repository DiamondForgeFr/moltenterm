// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

// Mark ready for review (#687): the developer's click on a draft PR, in the Reviews list or its Review tab, runs
// `gh pr ready` through the developer's gh. GitHub then notifies the reviewers and the PR leaves the drafts. A failure
// is answered with a reason the window words in plain language, never as an RPC error.

const (
	MarkReadyCommand = "moltenreviewmarkready"

	MarkReadyDone   = "ready"
	MarkReadyFailed = "failed"

	MarkReadyReasonClosed     = "closed"
	MarkReadyReasonPermission = "permission"
	MarkReadyReasonAuth       = "auth"
	MarkReadyReasonNotFound   = "notfound"
	MarkReadyReasonNoGh       = "nogh"
	MarkReadyReasonError      = "error"
)

type MarkReadyRequest struct {
	PrKey
	Dir string `json:"dir"`
}

type MarkReadyResult struct {
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

func (req MarkReadyRequest) check() error {
	if err := req.PrKey.check(); err != nil {
		return err
	}
	return checkDir(req.Dir)
}

// MarkReady names the repository like every review gh call (runGh): gh resolves a remote named upstream before origin.
// gh answers success when the PR is already ready, which is what the developer asked for.
func (s *Service) MarkReady(ctx context.Context, req MarkReadyRequest) (MarkReadyResult, error) {
	if err := req.check(); err != nil {
		return MarkReadyResult{}, err
	}
	if s.gh == nil {
		return MarkReadyResult{Status: MarkReadyFailed, Reason: MarkReadyReasonNoGh}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, ghCallTimeout)
	defer cancel()
	_, err := s.gh(ctx, req.Dir, "pr", "ready", strconv.Itoa(req.Number), "--repo", req.Repo)
	if err != nil {
		return MarkReadyResult{Status: MarkReadyFailed, Reason: markReadyReason(err), Message: maskTokens(err.Error())}, nil
	}
	return MarkReadyResult{Status: MarkReadyDone}, nil
}

// markReadyReason reads gh's last error line: gh words a closed or merged PR as "is closed", GitHub's API a missing
// right as "Resource not accessible" or a push access, a lost login asks for `gh auth login`.
func markReadyReason(err error) string {
	var missing *mission.MissingProgramError
	if errors.As(err, &missing) {
		return MarkReadyReasonNoGh
	}
	text := strings.ToLower(err.Error())
	has := func(parts ...string) bool {
		for _, part := range parts {
			if strings.Contains(text, part) {
				return true
			}
		}
		return false
	}
	switch {
	case has("is closed", "is merged", "was merged"):
		return MarkReadyReasonClosed
	case has("gh auth login", "authentication", "http 401", "bad credentials"):
		return MarkReadyReasonAuth
	case has("resource not accessible", "push access", "permission", "http 403", "not authorized", "forbidden"):
		return MarkReadyReasonPermission
	case has("could not resolve to a pullrequest", "no pull requests found", "not found", "http 404"):
		return MarkReadyReasonNotFound
	}
	return MarkReadyReasonError
}
