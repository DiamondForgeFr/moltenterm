// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package release

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/sfticket"
	"github.com/wavetermdev/waveterm/pkg/molten/spawns"
)

// The release ticket follows the release (#2563). In a project that SaaSFoundry manages (its manifest and its workflow
// skill), each moment of a release moves the ticket to the status its workflow declares for it, through the workflow's
// own CLI so that its guards run: the preparation (In progress), the RC branch pushed (AI testing), the RC pull
// request open for review (In review), and, once a public release is back on the trunk, Done. A moment whose status the
// workflow does not declare is skipped, a ticket already at or past a status is never moved back, and a refusal of the
// workflow's guards stops the step with the guard's own message: nothing here sets an escape hatch, and a hatch the
// environment carries is not passed on. A project without SaaSFoundry sees none of this.

const (
	MomentPrepared = "prepared"
	MomentPushed   = "pushed"
	MomentReview   = "review"
	MomentShipped  = "shipped"

	// A call of the workflow's CLI reads a board and runs git: generous, so that only a hang ends it.
	workflowLimit = 10 * time.Minute

	// What the guards print is shown in the step's log, up to this many lines.
	maxRefusalLines = 30

	// The environment variables that switch the workflow's guards off (escape-hatches.md of its skill), all named so.
	workflowBypassPrefix = "SF_WORKFLOW_BYPASS_"
)

type ticketMoment struct {
	// The status of SaaSFoundry's workflows the ticket moves to, as its CLI normalizes the name.
	status string
	// How the release says it.
	label string
	when  string
}

var ticketMoments = map[string]ticketMoment{
	MomentPrepared: {sfticket.StatusInProgress, "In progress", "the release is being prepared"},
	MomentPushed:   {sfticket.StatusAiTesting, "AI testing", "the RC branch is pushed"},
	MomentReview:   {sfticket.StatusInReview, "In review", "the RC pull request is open for review"},
	MomentShipped:  {sfticket.StatusDone, "Done", "the release is back on the trunk"},
}

// WorkflowResult is what one call of the workflow's CLI printed, and its exit code.
type WorkflowResult struct {
	Stdout string
	Stderr string
	Code   int
}

// WorkflowRunner runs the workflow's CLI (a path) with the project's folder as its working directory. The error is for
// a CLI that could not run at all; one that ran and said no has its exit code in the result.
type WorkflowRunner func(ctx context.Context, dir string, cli string, args ...string) (WorkflowResult, error)

// ExecWorkflow runs the workflow's CLI with bash, without a prompt to wait for and without any escape hatch of the
// environment.
func ExecWorkflow(ctx context.Context, dir string, cli string, args ...string) (WorkflowResult, error) {
	ctx, cancel := context.WithTimeout(ctx, workflowLimit)
	defer cancel()
	cmd := spawns.Command(ctx, "bash", append([]string{cli}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(withoutWorkflowHatches(os.Environ()), "GIT_TERMINAL_PROMPT=0", "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	res := WorkflowResult{Stdout: stdout.String(), Stderr: stderr.String()}
	if ctx.Err() != nil {
		return res, fmt.Errorf("the workflow's CLI did not answer within %s", workflowLimit)
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		res.Code = exit.ExitCode()
		return res, nil
	}
	return res, err
}

func withoutWorkflowHatches(environ []string) []string {
	kept := make([]string, 0, len(environ))
	for _, entry := range environ {
		if !strings.HasPrefix(entry, workflowBypassPrefix) {
			kept = append(kept, entry)
		}
	}
	return kept
}

func (e *Env) workflow(ctx context.Context, dir string, wf *sfticket.Workflow, args ...string) (WorkflowResult, error) {
	run := e.Workflow
	if run == nil {
		run = ExecWorkflow
	}
	return run(ctx, dir, wf.Cli, args...)
}

// refusalLines is what a call printed, without colour codes, stderr first: the guards speak there.
func (r WorkflowResult) refusalLines() []string {
	var lines []string
	for _, text := range []string{r.Stderr, r.Stdout} {
		for _, line := range strings.Split(sfticket.StripAnsi(text), "\n") {
			if line = strings.TrimRight(line, " \t\r"); strings.TrimSpace(line) != "" {
				lines = append(lines, line)
			}
		}
	}
	return lines
}

// sayRefusal prints what the workflow's CLI answered, indented under the line that names the call, and returns its
// first line.
func (e *Env) sayRefusal(res WorkflowResult) string {
	lines := res.refusalLines()
	if len(lines) == 0 {
		return fmt.Sprintf("it exited with code %d and printed nothing", res.Code)
	}
	for i, line := range lines {
		if i == maxRefusalLines {
			e.printf("  … and %d more line(s)\n", len(lines)-maxRefusalLines)
			break
		}
		e.printf("  %s\n", line)
	}
	return strings.TrimSpace(lines[0])
}

// ticketStatus reads where the workflow has a ticket.
func (e *Env) ticketStatus(ctx context.Context, root string, wf *sfticket.Workflow, ticket int) (string, error) {
	res, err := e.workflow(ctx, root, wf, "status", strconv.Itoa(ticket))
	if err != nil {
		return "", fmt.Errorf("could not read the status of the release ticket #%d: %w; nothing is moved blindly, run the step again once it answers", ticket, err)
	}
	if res.Code != 0 {
		e.printf("The workflow could not tell where release ticket #%d is:\n", ticket)
		first := e.sayRefusal(res)
		return "", fmt.Errorf("could not read the status of the release ticket #%d: %s; nothing is moved blindly, run the step again once it answers", ticket, first)
	}
	status, ok := sfticket.ParseCurrentStatus(res.Stdout, ticket)
	if !ok {
		return "", fmt.Errorf("could not read the status of the release ticket #%d: the workflow's status command has no \"Ticket #%d is currently in status\" line; nothing is moved blindly", ticket, ticket)
	}
	return status, nil
}

// moveTicket moves the release ticket of the version (base, X.Y.Z) to the status of the moment, when the project's
// workflow declares one and the ticket is before it. It prints what it did, or why it did not.
func (e *Env) moveTicket(ctx context.Context, p *Project, base string, moment string) error {
	wf := sfticket.WorkflowOf(p.Root)
	if wf == nil {
		return nil
	}
	ticket, err := e.releaseTicket(ctx, p, base)
	if err != nil {
		e.printf("The release ticket's status is not moved: %v.\n", err)
		return nil
	}
	if ticket == 0 {
		return nil
	}
	m := ticketMoments[moment]
	target, want := wf.Find(m.status)
	if want < 0 {
		e.printf("Release ticket #%d stays where it is when %s: its workflow declares no %s status.\n", ticket, m.when, m.label)
		return nil
	}
	current, err := e.ticketStatus(ctx, p.Root, wf, ticket)
	if err != nil {
		return err
	}
	switch at := wf.Position(current); {
	case at < 0:
		e.printf("Release ticket #%d is in %q, which its workflow does not declare: not moved to %s.\n", ticket, current, target)
		return nil
	case at == want:
		e.printf("Release ticket #%d is already in %s.\n", ticket, current)
		return nil
	case at > want:
		e.printf("Release ticket #%d is already in %s, past %s: not moved back.\n", ticket, current, target)
		return nil
	}
	res, err := e.workflow(ctx, p.Root, wf, "update-status", strconv.Itoa(ticket), target)
	if err != nil {
		return fmt.Errorf("release ticket #%d was not moved to %s: %w; run the step again once the workflow answers", ticket, target, err)
	}
	if res.Code != 0 {
		e.printf("The workflow refused to move release ticket #%d to %s:\n", ticket, target)
		first := e.sayRefusal(res)
		return fmt.Errorf("release ticket #%d was not moved to %s, %s: %s; molten release sets no escape hatch: fix the cause (or move the ticket by hand), then run the step again", ticket, target, m.when, first)
	}
	e.printf("Release ticket #%d moved from %s to %s (%s).\n", ticket, current, target, m.when)
	return nil
}

// ticketShipped is the last moment of a version's release: a public release back on the trunk closes its ticket. A
// release candidate leaves it open, the version's ticket being the version's, and says so.
func (e *Env) ticketShipped(ctx context.Context, p *Project, tag string, isRc bool, base string) error {
	if !isRc {
		return e.moveTicket(ctx, p, base, MomentShipped)
	}
	if sfticket.WorkflowOf(p.Root) == nil {
		return nil
	}
	ticket, err := e.releaseTicket(ctx, p, base)
	if err != nil || ticket == 0 {
		return nil
	}
	e.printf("Release ticket #%d stays open: %s is a release candidate, and the ticket is Done once the public release is back on %s.\n", ticket, tag, p.Trunk)
	return nil
}
