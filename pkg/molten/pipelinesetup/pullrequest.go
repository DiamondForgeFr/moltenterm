// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/release"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The setup's write goes through a pull request (FR-MC-036, #1098): a tracked file of the developer's checkout never
// changes. MoltenTerm checks origin/<trunk> out in a worktree of its own, writes and validates the files there, makes
// one commit in the project's format, pushes a new branch and opens a draft pull request to the PR target branch. The
// developer merges it when they agree. The same commit can be taken as a patch instead (a project not on GitHub).

const (
	PrModePr    = "pr"
	PrModePatch = "patch"

	PrKindWrite  = "write"
	PrKindUpdate = "update"

	PrStepTicket   = "ticket"
	PrStepWorktree = "worktree"
	PrStepWrite    = "write"
	PrStepCommit   = "commit"
	PrStepPush     = "push"
	PrStepPr       = "pr"
	PrStepPatch    = "patch"

	PrStatePending = "pending"
	PrStateRunning = "running"
	PrStateDone    = "done"
	PrStateFailed  = "failed"
	PrStateSkipped = "skipped"

	// Why a job stopped, worded by the window under mc.setup.pr.failure.<code>.
	PrFailureMoved        = "moved"
	PrFailureLocalChanged = "localChanged"
	// The included uncommitted edits and origin changed the same lines.
	PrFailureIncludeConflict = "includeConflict"
	PrFailureUpdateChanged   = "updateChanged"
	PrFailureBranchExists    = "branchExists"
	PrFailureInvalid         = "invalid"
	PrFailureNothing         = "nothing"
	PrFailureFetch           = "fetch"
	PrFailureTicket          = "ticket"
	PrFailureWorktree        = "worktree"
	PrFailureCommit          = "commit"
	PrFailurePush            = "push"
	PrFailurePr              = "pr"
	PrFailureFailed          = "failed"

	PrBranchDescription = "release-pipeline"

	prJobTimeout = 5 * time.Minute
	// Finished jobs are kept for the window to read their outcome, then forgotten.
	prJobKeep     = 30 * time.Minute
	maxPatchBytes = 2 << 20
	maxOutputLen  = 600
	treePrefix    = "pipeline-"
)

// What the window shows before the click: where the pull request starts and goes, and its names ({N}: the ticket).
type PrPlan struct {
	// A git repository: a pull request or a patch can be made from it.
	Git bool `json:"git"`
	// origin is configured: the branch can be pushed (#1106); without it only the patch is offered.
	Remote bool   `json:"remote"`
	Ref    string `json:"ref"`
	Commit string `json:"commit"`
	Target string `json:"target"`
	// origin is on GitHub: the pull request is opened there, and tickets are GitHub issues.
	OnGithub       bool   `json:"ongithub"`
	TicketRequired bool   `json:"ticketrequired"`
	Branch         string `json:"branch"`
	Subject        string `json:"subject"`
	// The title of the ticket MoltenTerm creates when none is picked (the project's language for tickets: English).
	TicketTitle string `json:"tickettitle"`
	// The working copy's pipeline (or record) differs from the committed one; Included: the proposal is built on it.
	Uncommitted bool `json:"uncommitted"`
	// The uncommitted edits and origin changed the same lines: they cannot be included.
	Conflict  bool   `json:"conflict"`
	Included  bool   `json:"included"`
	LocalBase string `json:"localbase"`
	// The working copy's pipeline when it differs, for the window to show the edits.
	Local string `json:"local,omitempty"`
}

// The common part of Write's and Update's requests.
type PrRequest struct {
	IncludeLocal bool   `json:"includelocal,omitempty"`
	LocalBase    string `json:"localbase,omitempty"`
	Ticket       int    `json:"ticket,omitempty"`
	// When the commit format needs a ticket and none is picked: MoltenTerm creates an issue, titled NewTicket or the
	// plan's TicketTitle.
	CreateTicket bool   `json:"createticket,omitempty"`
	NewTicket    string `json:"newticket,omitempty"`
	Mode         string `json:"mode,omitempty"`
}

type PrStep struct {
	Id    string `json:"id"`
	State string `json:"state"`
	// Data shown beside the step: a branch, a short commit, a pull request number.
	Info string `json:"info,omitempty"`
}

type PrFailure struct {
	Code string `json:"code"`
	// git's or gh's own words, or the validator's, shown as they are under the code's sentence.
	Output string `json:"output,omitempty"`
	// The commit that moved the base ("develop moved").
	Commit string `json:"commit,omitempty"`
}

type PrJob struct {
	Id       string     `json:"id"`
	Dir      string     `json:"dir"`
	Kind     string     `json:"kind"`
	Mode     string     `json:"mode"`
	Steps    []PrStep   `json:"steps"`
	Finished bool       `json:"finished"`
	Failure  *PrFailure `json:"failure,omitempty"`
	Ref      string     `json:"ref"`
	Target   string     `json:"target"`
	OnGithub bool       `json:"ongithub"`
	Branch   string     `json:"branch,omitempty"`
	Subject  string     `json:"subject,omitempty"`
	Ticket   int        `json:"ticket,omitempty"`
	Commit   string     `json:"commit,omitempty"`
	PrUrl    string     `json:"prurl,omitempty"`
	PrNumber int        `json:"prnumber,omitempty"`
	Patch    string     `json:"patch,omitempty"`
	Files    []string   `json:"files"`
	// The technical documentation's backend page, once written (FR-MC-043).
	DocUrl string `json:"docurl,omitempty"`

	finishedAt time.Time
}

type PrStateRequest struct {
	Id string `json:"id"`
}

type TicketsRequest struct {
	Dir string `json:"dir"`
}

type Ticket struct {
	Number int    `json:"number"`
	Title  string `json:"title"`
}

type TicketsAnswer struct {
	Tickets []Ticket `json:"tickets"`
}

type prFiles struct {
	files map[string][]byte
	order []string
	// The technical documentation (FR-MC-043): built once the branch is known, and written to a backend once the pull
	// request is open (the page's address back).
	techDoc func(ctx context.Context, branch string, files *prFiles) error
	afterPr func(ctx context.Context, prUrl string) (string, error)
}

func (p *prFiles) add(rel string, data []byte) {
	if p.files == nil {
		p.files = map[string][]byte{}
	}
	if _, ok := p.files[rel]; !ok {
		p.order = append(p.order, rel)
	}
	p.files[rel] = data
}

// localHash names the working copy's pipeline and record together.
func localHash(b *baseFiles) string {
	return hashOf(append(append(append([]byte{}, b.LocalPipeline...), 0), b.LocalRecord...))
}

func ticketRequired(dir string) (bool, int) {
	c := release.ReadConvention(dir)
	return c.TicketScope, c.MaxHeader
}

// prNames: the branch and the commit subject, with the ticket ("{N}" for the window's preview, "" when none is needed).
func prNames(dir string, kind string, ticket string) (string, string) {
	text := "set up the release pipeline"
	if kind == PrKindUpdate {
		text = "update the release setup"
	}
	_, maxHeader := ticketRequired(dir)
	if ticket == "" {
		return "chore/" + PrBranchDescription, cutHeader("chore(release): "+text, maxHeader)
	}
	pattern := molten.FeatureBranchPattern(dir)
	if pattern == "" || !strings.Contains(pattern, "{N}") {
		pattern = "feature/{N}-{description}"
	}
	branch := strings.ReplaceAll(strings.ReplaceAll(pattern, "{N}", ticket), "{description}", PrBranchDescription)
	return branch, cutHeader("chore(#"+ticket+"): "+text, maxHeader)
}

func ticketTitle(kind string) string {
	if kind == PrKindUpdate {
		return "Update the release setup"
	}
	return "Declare the release pipeline"
}

func cutHeader(h string, max int) string {
	if max > 0 && len(h) > max {
		return strings.TrimSpace(h[:max-1]) + "…"
	}
	return h
}

func prTarget(dir string, trunk string) string {
	if target := molten.PrTargetBranch(dir); target != "" {
		return target
	}
	return trunk
}

func (s *Setup) planOf(dir string, b *baseFiles, kind string, include bool) PrPlan {
	required, _ := ticketRequired(dir)
	ticket := ""
	if required {
		ticket = "{N}"
	}
	plan := PrPlan{Git: b.Commit != "", Ref: b.Ref, Commit: shortSha(b.Commit), Target: prTarget(dir, b.Trunk), OnGithub: onGithub(dir),
		TicketRequired: required, Uncommitted: b.uncommitted(), Conflict: b.IncludeConflict, Included: include && b.uncommitted(),
		LocalBase: localHash(b)}
	plan.Remote = plan.Git && s.hasOrigin(context.Background(), dir)
	plan.Branch, plan.Subject = prNames(dir, kind, ticket)
	plan.TicketTitle = ticketTitle(kind)
	// The edits as they would be included: on an older checkout, the working copy's file also lacks what origin merged.
	if plan.Uncommitted {
		plan.Local = string(b.IncludedPipeline)
		if b.IncludeConflict {
			plan.Local = string(b.LocalPipeline)
		}
	}
	return plan
}

func shortSha(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}

func trimOutput(text string) string {
	text = strings.TrimSpace(text)
	if len(text) > maxOutputLen {
		text = "…" + text[len(text)-maxOutputLen:]
	}
	return text
}

func errText(err error, out []byte) string {
	if len(bytes.TrimSpace(out)) > 0 {
		return trimOutput(string(out))
	}
	if err != nil {
		return trimOutput(err.Error())
	}
	return ""
}

type prFailed struct {
	failure PrFailure
}

func (e *prFailed) Error() string {
	return e.failure.Code + ": " + e.failure.Output
}

func fail(code string, output string) error {
	return &prFailed{failure: PrFailure{Code: code, Output: output}}
}

func newJobId() string {
	suffix := make([]byte, 6)
	rand.Read(suffix)
	return hex.EncodeToString(suffix)
}

func (s *Setup) startJob(job *PrJob, steps []string, work func(ctx context.Context, job *PrJob) error) (PrJob, error) {
	s.jobLock.Lock()
	if s.jobs == nil {
		s.jobs = map[string]*PrJob{}
	}
	for id, j := range s.jobs {
		if j.Finished && time.Since(j.finishedAt) > prJobKeep {
			delete(s.jobs, id)
			continue
		}
		if !j.Finished && j.Dir == job.Dir {
			s.jobLock.Unlock()
			return PrJob{}, uimsg.Errorf(uimsg.Make("mission.setup.prBusy"), "a pull request of the release setup is already being prepared for this project")
		}
	}
	job.Id = newJobId()
	for _, id := range steps {
		job.Steps = append(job.Steps, PrStep{Id: id, State: PrStatePending})
	}
	if job.Files == nil {
		job.Files = []string{}
	}
	s.jobs[job.Id] = job
	snapshot := copyJob(job)
	s.jobLock.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), prJobTimeout)
		defer cancel()
		err := work(ctx, job)
		s.finishJob(job, err)
	}()
	return snapshot, nil
}

func copyJob(j *PrJob) PrJob {
	c := *j
	c.Steps = append([]PrStep{}, j.Steps...)
	c.Files = append([]string{}, j.Files...)
	if j.Failure != nil {
		f := *j.Failure
		c.Failure = &f
	}
	return c
}

func (s *Setup) update(job *PrJob, fn func(j *PrJob)) {
	s.jobLock.Lock()
	defer s.jobLock.Unlock()
	fn(job)
}

func (s *Setup) stepState(job *PrJob, id string, state string, info string) {
	s.update(job, func(j *PrJob) {
		for i := range j.Steps {
			if j.Steps[i].Id == id {
				j.Steps[i].State = state
				if info != "" {
					j.Steps[i].Info = info
				}
			}
		}
	})
}

func (s *Setup) finishJob(job *PrJob, err error) {
	s.update(job, func(j *PrJob) {
		j.Finished = true
		j.finishedAt = time.Now()
		if err == nil {
			return
		}
		failure := PrFailure{Code: PrFailureFailed, Output: trimOutput(err.Error())}
		if pf, ok := err.(*prFailed); ok {
			failure = pf.failure
		}
		j.Failure = &failure
		for i := range j.Steps {
			if j.Steps[i].State == PrStateRunning {
				j.Steps[i].State = PrStateFailed
			}
		}
	})
}

// PrState is a job's progress, for the window's live list.
func (s *Setup) PrState(req PrStateRequest) (PrJob, error) {
	s.jobLock.Lock()
	defer s.jobLock.Unlock()
	job, ok := s.jobs[req.Id]
	if !ok {
		return PrJob{}, uimsg.Errorf(uimsg.Make("mission.setup.prUnknown"), "this pull request job is no longer known: prepare it again")
	}
	return copyJob(job), nil
}

// Tickets lists the open issues a setup's commit can name, when origin is on GitHub.
func (s *Setup) Tickets(ctx context.Context, req TicketsRequest) (TicketsAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return TicketsAnswer{}, err
	}
	answer := TicketsAnswer{Tickets: []Ticket{}}
	if !onGithub(dir) || s.Run == nil {
		return answer, nil
	}
	out, err := s.Run(ctx, dir, "gh", "issue", "list", "--state", "open", "--limit", "100", "--json", "number,title")
	if err != nil {
		return answer, uimsg.Errorf(uimsg.Make("mission.setup.ticketsUnread", "detail", errText(err, nil)), "the open issues could not be read: %v", err)
	}
	json.Unmarshal(out, &answer.Tickets)
	if answer.Tickets == nil {
		answer.Tickets = []Ticket{}
	}
	return answer, nil
}

func (s *Setup) hasOrigin(ctx context.Context, dir string) bool {
	out, err := s.git(ctx, dir, "remote")
	if err != nil {
		return false
	}
	for _, name := range strings.Fields(string(out)) {
		if name == "origin" {
			return true
		}
	}
	return false
}

// prepareBase fetches origin's trunk and reads the committed files again: the job refuses a base that moved since the
// draft, and an included working copy that changed.
func (s *Setup) prepareBase(ctx context.Context, dir string, base string, req PrRequest, job *PrJob) (*baseFiles, error) {
	trunk := molten.ResolvedBranches(dir).Trunk
	if s.hasOrigin(ctx, dir) {
		if out, err := s.git(ctx, dir, "fetch", "--quiet", "origin", trunk); err != nil {
			return nil, fail(PrFailureFetch, errText(err, out))
		}
	}
	b, err := s.readBase(ctx, dir)
	if err != nil {
		return nil, fail(PrFailureFailed, err.Error())
	}
	if b.Commit == "" {
		return nil, uimsg.Errorf(uimsg.Make("mission.setup.noGit"), "the project is not a git repository with a %s branch: there is nothing to open a pull request on", trunk)
	}
	s.update(job, func(j *PrJob) { j.Ref = b.Ref })
	if hashOf(b.Pipeline) != base {
		moved := &prFailed{failure: PrFailure{Code: PrFailureMoved}}
		if out, err := s.git(ctx, dir, "log", "-1", "--format=%h", b.Commit, "--", molten.ProjectPipelineFile); err == nil {
			moved.failure.Commit = strings.TrimSpace(string(out))
		}
		return nil, moved
	}
	if req.IncludeLocal && localHash(b) != req.LocalBase {
		return nil, fail(PrFailureLocalChanged, "")
	}
	if req.IncludeLocal && b.IncludeConflict {
		return nil, fail(PrFailureIncludeConflict, "")
	}
	return b, nil
}

func (s *Setup) checkPrRequest(dir string, kind string, req *PrRequest) error {
	if req.Mode == "" {
		req.Mode = PrModePr
	}
	if req.Mode != PrModePr && req.Mode != PrModePatch {
		return fmt.Errorf("unknown mode %q", req.Mode)
	}
	if req.Ticket < 0 || len(req.NewTicket) > 200 {
		return fmt.Errorf("not a ticket")
	}
	required, _ := ticketRequired(dir)
	if required && req.Ticket == 0 && req.Mode == PrModePr && !req.CreateTicket {
		return uimsg.Errorf(uimsg.Make("mission.setup.ticketNeeded"), "the project's commit format names a ticket: pick one or create one")
	}
	return nil
}

func jobSteps(dir string, req PrRequest) []string {
	required, _ := ticketRequired(dir)
	var steps []string
	if required && req.Ticket == 0 && req.Mode == PrModePr && req.CreateTicket {
		steps = append(steps, PrStepTicket)
	}
	steps = append(steps, PrStepWorktree, PrStepWrite, PrStepCommit)
	if req.Mode == PrModePatch {
		return append(steps, PrStepPatch)
	}
	return append(steps, PrStepPush, PrStepPr)
}

var issueNumberRegex = regexp.MustCompile(`/(?:issues|pull)/(\d+)\s*$`)

func numberOfUrl(url string) int {
	m := issueNumberRegex.FindStringSubmatch(strings.TrimSpace(url))
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

func (s *Setup) createTicket(ctx context.Context, dir string, title string, kind string) (int, error) {
	body := "Declares the project's release pipeline in `.molten/project.json`, drafted by MoltenTerm's release setup and reviewed in its pull request."
	if kind == PrKindUpdate {
		body = "Updates the project's release pipeline in `.molten/project.json` to what this version of MoltenTerm writes, reviewed in its pull request."
	}
	out, err := s.Run(ctx, dir, "gh", "issue", "create", "--title", strings.TrimSpace(title), "--body", body)
	if err != nil {
		return 0, fail(PrFailureTicket, errText(err, nil))
	}
	n := numberOfUrl(string(out))
	if n == 0 {
		return 0, fail(PrFailureTicket, trimOutput(string(out)))
	}
	return n, nil
}

func (s *Setup) treesDir() string {
	if s.TreesDir != "" {
		return s.TreesDir
	}
	return filepath.Join(os.TempDir(), "molten-setup-trees")
}

// runPr makes the commit in a worktree of origin/<trunk>, then pushes it and opens the pull request, or takes it as a
// patch. The worktree is removed whatever happens; the folder opened is never written.
func (s *Setup) runPr(ctx context.Context, dir string, b *baseFiles, files prFiles, req PrRequest, job *PrJob) error {
	ticket := req.Ticket
	required, _ := ticketRequired(dir)
	if required && ticket == 0 && req.Mode == PrModePr && req.CreateTicket {
		title := strings.TrimSpace(req.NewTicket)
		if title == "" {
			title = ticketTitle(job.Kind)
		}
		s.stepState(job, PrStepTicket, PrStateRunning, "")
		n, err := s.createTicket(ctx, dir, title, job.Kind)
		if err != nil {
			return err
		}
		ticket = n
		s.stepState(job, PrStepTicket, PrStateDone, "#"+strconv.Itoa(n))
	}
	ticketText := ""
	if required && ticket > 0 {
		ticketText = strconv.Itoa(ticket)
	}
	branch, subject := prNames(dir, job.Kind, ticketText)
	s.update(job, func(j *PrJob) {
		j.Branch, j.Subject, j.Ticket = branch, subject, ticket
	})
	if files.techDoc != nil {
		if err := files.techDoc(ctx, branch, &files); err != nil {
			return fail(PrFailureInvalid, err.Error())
		}
		s.update(job, func(j *PrJob) { j.Files = append([]string{}, files.order...) })
	}
	s.stepState(job, PrStepWorktree, PrStateRunning, "")
	if req.Mode == PrModePr && s.hasOrigin(ctx, dir) {
		out, err := s.git(ctx, dir, "ls-remote", "--heads", "origin", "refs/heads/"+branch)
		if err != nil {
			return fail(PrFailurePush, errText(err, out))
		}
		if len(bytes.TrimSpace(out)) > 0 {
			return fail(PrFailureBranchExists, "")
		}
	}
	noHooks := filepath.Join(s.treesDir(), "nohooks")
	parent := filepath.Join(s.treesDir(), hashOf([]byte(dir))[:16])
	if err := os.MkdirAll(noHooks, 0700); err != nil {
		return fail(PrFailureWorktree, err.Error())
	}
	if err := os.MkdirAll(parent, 0700); err != nil {
		return fail(PrFailureWorktree, err.Error())
	}
	// One job per project at a time: a worktree left in the folder is an interrupted job's.
	if entries, err := os.ReadDir(parent); err == nil {
		for _, entry := range entries {
			if entry.IsDir() && strings.HasPrefix(entry.Name(), treePrefix) {
				s.removeTree(dir, filepath.Join(parent, entry.Name()))
			}
		}
	}
	tree := filepath.Join(parent, treePrefix+job.Id)
	// The project's hooks are its code, which the setup does not trust: none runs on its checkout or its commit.
	git := func(args ...string) ([]byte, error) {
		return s.git(ctx, tree, append([]string{"-c", "core.hooksPath=" + noHooks}, args...)...)
	}
	if out, err := s.git(ctx, dir, "-c", "core.hooksPath="+noHooks, "-c", "core.fsmonitor=false", "worktree", "add", "--detach", "--quiet", tree, b.Commit); err != nil {
		os.RemoveAll(tree)
		return fail(PrFailureWorktree, errText(err, out))
	}
	defer s.removeTree(dir, tree)
	s.stepState(job, PrStepWorktree, PrStateDone, shortSha(b.Commit))
	s.stepState(job, PrStepWrite, PrStateRunning, "")
	if report := molten.ValidatePipelineData(tree, files.files[molten.ProjectPipelineFile]); !report.Valid {
		return fail(PrFailureInvalid, strings.Join(report.Errors, "; "))
	}
	for _, rel := range files.order {
		if _, err := writeProjectFile(tree, rel, files.files[rel]); err != nil {
			return fail(PrFailureFailed, err.Error())
		}
	}
	if report := molten.ValidatePipeline(tree); !report.Valid {
		return fail(PrFailureInvalid, strings.Join(report.Errors, "; "))
	}
	s.stepState(job, PrStepWrite, PrStateDone, strconv.Itoa(len(files.order)))
	s.stepState(job, PrStepCommit, PrStateRunning, "")
	if out, err := git(append([]string{"add", "--"}, files.order...)...); err != nil {
		return fail(PrFailureCommit, errText(err, out))
	}
	if out, err := git("diff", "--cached", "--quiet"); err == nil {
		return fail(PrFailureNothing, "")
	} else if len(out) > 0 {
		return fail(PrFailureCommit, errText(err, out))
	}
	message := subject + "\n\nWritten by MoltenTerm's release setup on " + b.Ref + " (" + shortSha(b.Commit) + ")."
	if out, err := git("commit", "--quiet", "--no-verify", "-m", message); err != nil {
		return fail(PrFailureCommit, errText(err, out))
	}
	out, err := git("rev-parse", "HEAD")
	if err != nil {
		return fail(PrFailureCommit, errText(err, out))
	}
	commit := strings.TrimSpace(string(out))
	s.update(job, func(j *PrJob) { j.Commit = commit })
	s.stepState(job, PrStepCommit, PrStateDone, shortSha(commit))
	if req.Mode == PrModePatch {
		s.stepState(job, PrStepPatch, PrStateRunning, "")
		patch, err := git("format-patch", "-1", "--stdout", "HEAD")
		if err != nil || len(patch) > maxPatchBytes {
			return fail(PrFailureCommit, errText(err, nil))
		}
		s.update(job, func(j *PrJob) { j.Patch = string(patch) })
		s.stepState(job, PrStepPatch, PrStateDone, "")
		return nil
	}
	s.stepState(job, PrStepPush, PrStateRunning, "")
	if out, err := git("push", "--quiet", "origin", "HEAD:refs/heads/"+branch); err != nil {
		return fail(PrFailurePush, errText(err, out))
	}
	s.stepState(job, PrStepPush, PrStateDone, branch)
	if !job.OnGithub {
		s.stepState(job, PrStepPr, PrStateSkipped, "")
		s.writeTechDoc(ctx, job, files, "")
		return nil
	}
	s.stepState(job, PrStepPr, PrStateRunning, "")
	body := prBody(job, b, files, ticket, required)
	created, err := s.Run(ctx, dir, "gh", "pr", "create", "--draft", "--base", job.Target, "--head", branch, "--title", subject, "--body", body)
	if err != nil {
		return fail(PrFailurePr, errText(err, nil))
	}
	url := strings.TrimSpace(string(created))
	if lines := strings.Split(url, "\n"); len(lines) > 0 {
		url = strings.TrimSpace(lines[len(lines)-1])
	}
	n := numberOfUrl(url)
	s.update(job, func(j *PrJob) { j.PrUrl, j.PrNumber = url, n })
	s.stepState(job, PrStepPr, PrStateDone, "#"+strconv.Itoa(n))
	s.writeTechDoc(ctx, job, files, url)
	return nil
}

// writeTechDoc writes the document to its backend once the pull request is open; a failure is the step's, the pull
// request stays open.
func (s *Setup) writeTechDoc(ctx context.Context, job *PrJob, files prFiles, prUrl string) {
	if files.afterPr == nil {
		s.stepState(job, PrStepDoc, PrStateSkipped, "")
		return
	}
	s.stepState(job, PrStepDoc, PrStateRunning, "")
	page, err := files.afterPr(ctx, prUrl)
	if err != nil {
		s.stepState(job, PrStepDoc, PrStateFailed, trimOutput(err.Error()))
		return
	}
	s.update(job, func(j *PrJob) { j.DocUrl = page })
	s.stepState(job, PrStepDoc, PrStateDone, "")
}

func prBody(job *PrJob, b *baseFiles, files prFiles, ticket int, required bool) string {
	var out strings.Builder
	if job.Kind == PrKindUpdate {
		out.WriteString("Updates the release setup to what this version of MoltenTerm writes, with the changes chosen in its update dialog.\n\n")
	} else {
		out.WriteString("Declares the release pipeline drafted by MoltenTerm's release setup and reviewed in its dialog.\n\n")
	}
	out.WriteString("Files:\n")
	for _, rel := range files.order {
		out.WriteString("- `" + rel + "`\n")
	}
	fmt.Fprintf(&out, "\nBuilt on %s at %s. Only the release, versions, branches and steps blocks change; every other key of the file stays as it is. The Release menu uses the pipeline once this pull request is merged; its commands then ask for your trust.\n", b.Ref, shortSha(b.Commit))
	if required && ticket > 0 {
		fmt.Fprintf(&out, "\nResolves #%d\n", ticket)
	}
	out.WriteString("\nOpened by MoltenTerm's release setup.\n")
	return out.String()
}

func (s *Setup) removeTree(dir string, tree string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if _, err := s.git(ctx, dir, "worktree", "remove", "--force", tree); err == nil {
		return
	}
	os.RemoveAll(tree)
	s.git(ctx, dir, "worktree", "prune")
}
