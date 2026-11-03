// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/sfticket"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The setup's pull request follows the project's workflow (#1788). A draft only waits for the developer when the
// workflow tests a change by hand before its review (a Human Testing status, the ticket not nature:internal): there the
// developer takes it out of draft, and MoltenTerm says so once its checks pass. Every other project gets the pull
// request ready for review from the start: its review is the human gate, and a draft would only hide it. The ticket
// MoltenTerm creates goes through the project's ticket tool when it has one (a SaaSFoundry project's github-projects
// CLI), so it lands on the board typed, labelled and with a complexity the workflow's guards accept.

const (
	SetupTicketComplexity = sfticket.ComplexityLow
	SetupTicketNature     = sfticket.NatureInternal
	SetupTicketType       = sfticket.TypeTask
	SetupSrsBypassReason  = "release-setup"
)

type sfWorkflow struct {
	Workflow struct {
		Statuses []struct {
			Name string `json:"name"`
		} `json:"statuses"`
	} `json:"workflow"`
}

func readSfWorkflow(dir string) (sfWorkflow, bool) {
	var sf sfWorkflow
	data, err := os.ReadFile(filepath.Join(dir, molten.ProjectSaaSFoundryFile))
	if err != nil {
		return sf, false
	}
	if json.Unmarshal(data, &sf) != nil {
		return sf, false
	}
	return sf, true
}

func normalizedStatus(name string) string {
	return strings.Join(strings.Fields(strings.ToLower(name)), " ")
}

// WorkflowHasHumanTesting: the project's workflow declares a Human Testing status.
func WorkflowHasHumanTesting(dir string) bool {
	sf, ok := readSfWorkflow(dir)
	if !ok {
		return false
	}
	for _, status := range sf.Workflow.Statuses {
		if normalizedStatus(status.Name) == "human testing" {
			return true
		}
	}
	return false
}

// prOpensDraft: whether the pull request waits for the developer as a draft. internal: the ticket is the one the
// ticket tool made, nature:internal; another one is read (an unreadable one counts as tested by hand, the safe side).
func (s *Setup) prOpensDraft(ctx context.Context, dir string, ticket int, internal bool) bool {
	if !WorkflowHasHumanTesting(dir) || internal {
		return false
	}
	if ticket <= 0 {
		return true
	}
	out, err := s.Run(ctx, dir, "gh", "issue", "view", strconv.Itoa(ticket), "--json", "labels")
	if err != nil {
		return true
	}
	var issue struct {
		Labels []struct {
			Name string `json:"name"`
		} `json:"labels"`
	}
	if json.Unmarshal(out, &issue) != nil {
		return true
	}
	for _, label := range issue.Labels {
		if strings.EqualFold(strings.TrimSpace(label.Name), "nature:"+SetupTicketNature) {
			return false
		}
	}
	return true
}

// createSfTicket creates the ticket through the project's own CLI, as its workflow does: on the board, typed as a
// task, complexity low, nature internal. The CLI is the copy committed at the setup's base, the one the project
// reviewed, never the working copy's. ok false: nothing was created, the plain issue is made instead.
func (s *Setup) createSfTicket(ctx context.Context, dir string, base string, rel string, title string, body string) (int, bool) {
	if base == "" {
		return 0, false
	}
	script, err := s.git(ctx, dir, "show", base+":"+rel)
	if err != nil {
		return 0, false
	}
	spec := sfticket.Spec{Type: SetupTicketType, Title: title, Body: body, Complexity: SetupTicketComplexity,
		Nature: SetupTicketNature, SrsBypassReason: SetupSrsBypassReason}
	n, ok, _ := sfticket.Create(ctx, sfticket.Runner(s.Run), dir, script, s.treesDir(), spec)
	return n, ok
}

func ticketBody(kind string) string {
	if kind == PrKindUpdate {
		return "Updates the project's release pipeline in `.molten/project.json` to what this version of MoltenTerm writes, reviewed in its pull request."
	}
	return "Declares the project's release pipeline in `.molten/project.json`, drafted by MoltenTerm's release setup and reviewed in its pull request."
}

// The setup's Mark ready (#1788): the developer's click in step 3 or on the notification runs `gh pr ready` on the
// pull request's address, which names its repository whatever the remotes are called.

var setupPrUrlRegex = regexp.MustCompile(`^https://[^\s/]+/[^\s/]+/[^\s/]+/pull/\d+$`)

type PrReadyRequest struct {
	Dir string `json:"dir"`
	Url string `json:"url"`
}

type PrReadyAnswer struct {
	Ready bool `json:"ready"`
}

func (s *Setup) PrReady(ctx context.Context, req PrReadyRequest) (PrReadyAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return PrReadyAnswer{}, err
	}
	url := strings.TrimSpace(req.Url)
	if !setupPrUrlRegex.MatchString(url) {
		return PrReadyAnswer{}, fmt.Errorf("not a pull request address: %q", url)
	}
	if s.Run == nil {
		return PrReadyAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.prReadyFailed", "detail", "gh"), "gh is not available")
	}
	if _, err := s.Run(ctx, dir, "gh", "pr", "ready", url); err != nil {
		return PrReadyAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.prReadyFailed", "detail", errText(err, nil)),
			"the pull request could not be marked ready: %v", err)
	}
	return PrReadyAnswer{Ready: true}, nil
}
