// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/release"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// What the release panel reads (FR-MC-016), as Notulia's dev_release_facts: the panel derives the phases from these
// facts and stores none of them, so a release cut at the terminal, or followed across a restart, reads exactly like one
// launched from the Project tab. Only the intent of a release launched here (the session) is written down.

const (
	// A tag cut at the terminal is followed while it is this young.
	releaseFollowTerminal = 3 * 24 * time.Hour
	releaseFactsTimeout   = 30 * time.Second
	releaseTailLines      = 6
	maxReleaseNotesBytes  = 256 << 10
)

var notesRegex = regexp.MustCompile(`(?m)^\s*▶ notes:\s*(.+?)\s*$`)

// What the release chain prints once it ran the project's formatter on the files it wrote (release.FormatMarker, #1095).
var formatRegex = regexp.MustCompile(`(?m)^\s*▶ format:\s*(formatted|none|failed)\s*(.*?)\s*$`)

// What `molten release dispatch` prints while a run waits for an environment approval, and once it goes on (FR-MC-037).
var approvalRegex = regexp.MustCompile(`(?m)^\s*▶ (approval|approved):\s*(\S+)\s*(\S*)\s*$`)

// The last run of a declared release step for the release followed.
type ReleaseStepFact struct {
	RunId   string   `json:"runid"`
	State   string   `json:"state"`
	Running bool     `json:"running"`
	Exit    *int     `json:"exit,omitempty"`
	Tail    []string `json:"tail"`
	Phases  []string `json:"phases"`
	// The environment the running step's GitHub run waits on for an approval (FR-MC-037).
	Approval *ReleaseApproval `json:"approval,omitempty"`
}

// A GitHub run waiting for a reviewer to approve its deployment to an environment.
type ReleaseApproval struct {
	Environment string `json:"environment"`
	Url         string `json:"url,omitempty"`
	Workflow    string `json:"workflow,omitempty"`
}

type ReleaseGhRun struct {
	DatabaseId   int64  `json:"databaseId"`
	WorkflowName string `json:"workflowName"`
	HeadBranch   string `json:"headBranch"`
	Status       string `json:"status"`
	Conclusion   string `json:"conclusion"`
	Url          string `json:"url"`
	CreatedAt    string `json:"createdAt"`
}

type ReleaseGhJob struct {
	Name        string `json:"name"`
	Status      string `json:"status"`
	Conclusion  string `json:"conclusion"`
	StartedAt   string `json:"startedAt"`
	CompletedAt string `json:"completedAt"`
	Url         string `json:"url"`
}

type ReleaseGhRelease struct {
	TagName      string `json:"tagName"`
	IsDraft      bool   `json:"isDraft"`
	IsPrerelease bool   `json:"isPrerelease"`
	Url          string `json:"url"`
}

type ReleasePr struct {
	Number      int    `json:"number"`
	Url         string `json:"url"`
	Title       string `json:"title"`
	HeadRefName string `json:"headRefName"`
}

type ReleaseFacts struct {
	// The release launched from the Project tab; nil for a tag cut at the terminal.
	Session   *ReleaseSession `json:"session,omitempty"`
	Tag       string          `json:"tag,omitempty"`
	Version   string          `json:"version,omitempty"`
	Channel   string          `json:"channel,omitempty"`
	TagExists bool            `json:"tagexists"`
	Trunk     string          `json:"trunk,omitempty"`
	// The declared steps' last runs, by their own ids only.
	Steps map[string]ReleaseStepFact `json:"steps"`
	// The preparation's last run, which is none of the declared steps (#230).
	Preparation *ReleaseStepFact `json:"preparation,omitempty"`
	// The public notes drafted for the cut, while the tag is not pushed yet.
	Notes string `json:"notes,omitempty"`
	// The notes were written since the release started: a step of this release drafted them.
	NotesDrafted bool `json:"notesdrafted"`
	// The project is not on GitHub: no run, release or pull request of it is to be waited for.
	NoGithub bool `json:"nogithub"`
	// GitHub, through the user's gh: the runs the tag started, the newest one's jobs, the release.
	GithubError string            `json:"githuberror,omitempty"`
	Runs        []ReleaseGhRun    `json:"runs"`
	Jobs        []ReleaseGhJob    `json:"jobs"`
	Release     *ReleaseGhRelease `json:"release,omitempty"`
	// The runs the tag started that wait for an environment approval (FR-MC-037).
	Approvals []ReleaseApproval `json:"approvals"`
	// The workflows the pushed tag starts, read at the tag; nil when they could not be read (#1040).
	TagWorkflows *ReleaseTagWorkflows `json:"tagworkflows,omitempty"`
	// The release commit is on the trunk, or a pull request carries it back.
	OnTrunk bool       `json:"ontrunk"`
	BackPr  *ReleasePr `json:"backpr,omitempty"`
	// A candidate tagged on its RC branch (#1046): it reaches neither the release branch nor the trunk.
	OffRelease bool `json:"offrelease,omitempty"`
	// The pull request that brings the release to the release branch, while the tag is not pushed (#1046).
	ReleasePr *ReleasePr `json:"releasepr,omitempty"`
	// A running step waits for a branch's GitHub CI (the promotion, #836).
	Awaits *ReleaseCiAwait `json:"awaits,omitempty"`
	// The last word of the release chain on formatting its files, while the tag is not pushed (#1095).
	Format *ReleaseFormat `json:"format,omitempty"`
	// What the changelog sections written by hand cover, while the tag is not pushed (#1142).
	ChangelogScope *ReleaseChangelogScope `json:"changelogscope,omitempty"`
}

// The scope of the release's changelog sections (#1142): everything since the last public release, candidates
// included, for a public version; since the previous release of either channel for a candidate.
type ReleaseChangelogScope struct {
	// "" for the first release.
	Since string `json:"since"`
	// The manual steps that write a changelog section.
	Steps []string `json:"steps"`
}

// How the release's files last went through the project's formatter (#1095): formatted, none (no formatter found) or
// failed.
type ReleaseFormat struct {
	State string `json:"state"`
	// The formatter that formatted them.
	Formatter string `json:"formatter,omitempty"`
	// What failed, to be run in the release worktree.
	Command string `json:"command,omitempty"`
	// The step whose run said it.
	Step string `json:"step"`
}

type ReleaseStepRequest struct {
	Dir  string `json:"dir"`
	Tag  string `json:"tag"`
	Step string `json:"step"`
	// Records a manual step although its check fails (#1095): the developer confirmed it is done anyway.
	Force bool `json:"force,omitempty"`
}

type ReleaseNotesRequest struct {
	Dir  string `json:"dir"`
	Tag  string `json:"tag"`
	Text string `json:"text,omitempty"`
}

type ReleaseNotes struct {
	Path string `json:"path"`
	Text string `json:"text"`
}

func releaseChannelOf(isRc bool) string {
	if isRc {
		return ReleaseChannelRc
	}
	return ReleaseChannelPublic
}

// followedRelease is the release launched from the Project tab, or else the newest release tag when it was cut lately.
func (r *Runs) followedRelease(ctx context.Context, dir string, p *molten.Pipeline) (ReleaseSession, bool) {
	if session, _ := r.ReleaseSessionOf(dir); session != nil {
		return *session, true
	}
	// Newest first; tags made in the same second are ordered by version (git sorts by the last key first).
	out, err := r.git(ctx, dir, "git", "for-each-ref", "--sort=-v:refname", "--sort=-creatordate", "--format=%(refname:short)\t%(creatordate:unix)", "refs/tags")
	if err != nil {
		return ReleaseSession{}, false
	}
	ignored := r.ignoredReleases(dir)
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name, date, _ := strings.Cut(line, "\t")
		version, isRc, err := releaseVersion(p, name)
		if err != nil {
			continue
		}
		if slices.Contains(ignored, name) {
			return ReleaseSession{}, false
		}
		seconds, _ := strconv.ParseInt(date, 10, 64)
		created := time.Unix(seconds, 0)
		if r.now().Sub(created) > releaseFollowTerminal {
			return ReleaseSession{}, false
		}
		return ReleaseSession{Tag: name, Version: version, Channel: releaseChannelOf(isRc), StartedAt: created.UnixMilli()}, true
	}
	return ReleaseSession{}, false
}

// stepFacts reads the last run of each declared release step for the tag, and the preparation's apart. Runs started
// before `since` (the release launched here) belong to an earlier, abandoned attempt at the same tag and are not read.
func (r *Runs) stepFacts(dir string, tag string, since int64) (map[string]ReleaseStepFact, *ReleaseStepFact, string, *ReleaseFormat) {
	facts := map[string]ReleaseStepFact{}
	var preparation *ReleaseStepFact
	var format *ReleaseFormat
	notes := ""
	runs := r.List(dir)
	// Oldest first, so that the newest run of a step, and the newest notes announced, win.
	for i := len(runs) - 1; i >= 0; i-- {
		rec := runs[i]
		if rec.Kind != RunKindRelease || rec.Tag != tag || rec.StartedAt < since {
			continue
		}
		data, _ := os.ReadFile(r.logFile(dir, rec.Id))
		fact := ReleaseStepFact{RunId: rec.Id, State: rec.State, Running: rec.State == RunStateRunning, Exit: rec.Exit, Phases: rec.Phases, Tail: []string{}}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimRight(line, "\r")
			if strings.TrimSpace(line) == "" || notesRegex.MatchString(line) || formatRegex.MatchString(line) {
				continue
			}
			fact.Tail = append(fact.Tail, line)
		}
		fact.Tail = fact.Tail[max(0, len(fact.Tail)-releaseTailLines):]
		if fact.Running {
			fact.Approval = pendingApproval(data)
		}
		if rec.StepId == ReleasePreparationStepId {
			preparation = &fact
		} else {
			facts[rec.StepId] = fact
		}
		if m := notesRegex.FindAllSubmatch(data, -1); len(m) > 0 {
			path := expandHome(string(m[len(m)-1][1]))
			if !filepath.IsAbs(path) {
				path = filepath.Join(dir, rec.Cwd, path)
			}
			notes = filepath.Clean(path)
		}
		if m := formatRegex.FindAllSubmatch(data, -1); len(m) > 0 {
			last := m[len(m)-1]
			format = &ReleaseFormat{State: string(last[1]), Step: rec.StepId}
			switch format.State {
			case release.FormatFormatted:
				format.Formatter = string(last[2])
			case release.FormatFailed:
				format.Command = string(last[2])
			}
		}
	}
	return facts, preparation, notes, format
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func writtenSince(path string, since int64) bool {
	info, err := os.Stat(path)
	return err == nil && info.ModTime().UnixMilli() >= since
}

// notesPath is where the public notes of the cut are: those a step announced, or else the project's versions.notes,
// in the project or, as Notulia drafts them, in another worktree of its repository (a release worktree beside it)
// when written for this release; the newest of those wins.
func (r *Runs) notesPath(ctx context.Context, dir string, p *molten.Pipeline, tag string, announced string, since int64) string {
	if announced != "" {
		if isFile(announced) {
			return announced
		}
		return ""
	}
	if p.Versions == nil || p.Versions.Notes == "" {
		return ""
	}
	rel := filepath.FromSlash(strings.ReplaceAll(p.Versions.Notes, "{tag}", tag))
	if own := filepath.Join(dir, rel); isFile(own) {
		return own
	}
	g := &gitReader{ctx: ctx, run: r.git, dir: dir}
	best, bestTime := "", int64(0)
	for _, line := range g.lines("worktree", "list", "--porcelain") {
		worktree, ok := strings.CutPrefix(line, "worktree ")
		if !ok || filepath.Clean(worktree) == dir {
			continue
		}
		path := filepath.Join(worktree, rel)
		info, err := os.Stat(path)
		if err != nil || info.IsDir() || info.ModTime().UnixMilli() < since {
			continue
		}
		if t := info.ModTime().UnixMilli(); best == "" || t > bestTime {
			best, bestTime = path, t
		}
	}
	return best
}

func (r *Runs) readGithubRelease(ctx context.Context, dir string, facts *ReleaseFacts) {
	out, err := ghJson(ctx, r.git, dir, "run", "list", "--limit", "30", "--json", "databaseId,workflowName,headBranch,status,conclusion,url,createdAt")
	if err != nil && isNotGithubError(err) {
		facts.NoGithub = true
		return
	}
	if err != nil {
		facts.GithubError = err.Error()
		return
	}
	var runs []ReleaseGhRun
	json.Unmarshal(out, &runs)
	for _, run := range runs {
		if run.HeadBranch == facts.Tag {
			facts.Runs = append(facts.Runs, run)
		}
	}
	if len(facts.Runs) > 0 {
		facts.Approvals = r.waitingApprovals(ctx, dir, facts.Runs)
		if out, err := ghJson(ctx, r.git, dir, "run", "view", strconv.FormatInt(facts.Runs[0].DatabaseId, 10), "--json", "jobs"); err == nil {
			var view struct {
				Jobs []ReleaseGhJob `json:"jobs"`
			}
			json.Unmarshal(out, &view)
			facts.Jobs = view.Jobs
		}
	}
	if out, err := ghJson(ctx, r.git, dir, "release", "view", facts.Tag, "--json", "tagName,isDraft,isPrerelease,url"); err == nil {
		var release ReleaseGhRelease
		if json.Unmarshal(out, &release) == nil && release.TagName != "" {
			facts.Release = &release
		}
	}
	if out, err := ghJson(ctx, r.git, dir, "pr", "list", "--state", "open", "--base", facts.Trunk, "--limit", "30", "--json", "number,url,title,headRefName"); err == nil {
		var prs []ReleasePr
		json.Unmarshal(out, &prs)
		for _, pr := range prs {
			if mentionsRelease(pr.HeadRefName, facts.Tag) || mentionsRelease(pr.Title, facts.Tag) {
				facts.BackPr = &pr
				break
			}
		}
	}
}

var tagVersionRegex = regexp.MustCompile(`\d+\.\d+\.\d+(?:-\d+)?$`)

// mentionsRelease tells whether a branch name or a title names this release's version as a whole: the pull request
// carrying v1.0.0-1 back is not v1.0.0's, nor v1.0.0-10's.
func mentionsRelease(s string, tag string) bool {
	version := tagVersionRegex.FindString(tag)
	if version == "" {
		return false
	}
	for from := 0; ; {
		i := strings.Index(s[from:], version)
		if i < 0 {
			return false
		}
		start, end := from+i, from+i+len(version)
		before := start == 0 || !strings.ContainsRune("0123456789.", rune(s[start-1]))
		after := end == len(s) || !(s[end] >= '0' && s[end] <= '9' || s[end] == '.' || (s[end] == '-' && end+1 < len(s) && s[end+1] >= '0' && s[end+1] <= '9'))
		if before && after {
			return true
		}
		from = start + 1
	}
}

// onTrunk tells whether the tagged commit's change is on the trunk: merged, or carried back by a cherry-pick.
func (r *Runs) onTrunk(ctx context.Context, dir string, trunkRef string, tag string) bool {
	if trunkRef == "" {
		return false
	}
	commit := releaseCommitOfTag(ctx, r.git, dir, tag)
	out, err := r.git(ctx, dir, "git", "cherry", trunkRef, commit, commit+"^")
	if err != nil {
		return false
	}
	return !strings.Contains(string(out), "+")
}

// releasesByPr tells whether the pipeline brings its releases to the release branch by pull request (#1046).
func releasesByPr(p *molten.Pipeline) bool {
	if p.Release == nil {
		return false
	}
	for _, steps := range [][]molten.PipelineStep{p.Release.Rc, p.Release.Public} {
		for _, s := range steps {
			if run := strings.TrimSpace(s.Run); strings.HasPrefix(run, "molten release open-pr") || strings.HasPrefix(run, "molten release tag") && strings.Contains(run, "--rc-branch") {
				return true
			}
		}
	}
	return false
}

// releasePrOf finds the open pull request to the release branch whose title names the release.
func (r *Runs) releasePrOf(ctx context.Context, dir string, tag string) *ReleasePr {
	releaseBranch := molten.ResolvedBranches(dir).Release
	out, err := ghJson(ctx, r.git, dir, "pr", "list", "--state", "open", "--base", releaseBranch, "--limit", "30", "--json", "number,url,title,headRefName")
	if err != nil {
		return nil
	}
	var prs []ReleasePr
	json.Unmarshal(out, &prs)
	for _, pr := range prs {
		if release.TitleNamesTag(pr.Title, tag) {
			return &pr
		}
	}
	return nil
}

// releaseCommitOfTag is the commit a tag's release is in: the tagged commit, or, for a tag on the merge commit of a
// release pull request (#1046), the release commit that pull request merged (release.ReleaseCommitSubject).
func releaseCommitOfTag(ctx context.Context, git Runner, dir string, tag string) string {
	if _, err := git(ctx, dir, "git", "rev-parse", "--verify", "--quiet", tag+"^2"); err != nil {
		return tag
	}
	out, err := git(ctx, dir, "git", "log", "-n", "500", "--format=%H%x1f%s%x1f%b%x1e", tag+"^1.."+tag)
	if err != nil {
		return tag
	}
	for _, record := range strings.Split(string(out), "\x1e") {
		fields := strings.SplitN(strings.TrimSpace(record), "\x1f", 3)
		if len(fields) == 3 && release.IsReleaseCommit(fields[1], fields[2], tag) {
			return fields[0]
		}
	}
	return tag
}

// ReleaseFactsOf reads every fact the release panel derives the phases from; no release followed gives empty facts.
func (r *Runs) ReleaseFactsOf(dir string) (ReleaseFacts, error) {
	facts := ReleaseFacts{Steps: map[string]ReleaseStepFact{}, Runs: []ReleaseGhRun{}, Jobs: []ReleaseGhJob{}, Approvals: []ReleaseApproval{}}
	if err := checkDir(dir); err != nil {
		return facts, err
	}
	dir = filepath.Clean(dir)
	report := molten.ValidatePipeline(dir)
	if !report.Valid {
		return facts, nil
	}
	p := report.Pipeline
	ctx, cancel := context.WithTimeout(context.Background(), releaseFactsTimeout)
	defer cancel()
	r.git(ctx, dir, "git", "fetch", "--quiet", "--tags", "origin")
	session, ok := r.followedRelease(ctx, dir, p)
	if !ok {
		return facts, nil
	}
	since := int64(0)
	if stored, _ := r.ReleaseSessionOf(dir); stored != nil {
		facts.Session = stored
		since = stored.StartedAt
	}
	facts.Tag, facts.Version, facts.Channel = session.Tag, session.Version, session.Channel
	facts.TagExists = r.tagExists(dir, session.Tag)
	trunk, trunkRef := resolveTrunk(ctx, r.git, dir)
	facts.Trunk = trunk
	var announced string
	var format *ReleaseFormat
	facts.Steps, facts.Preparation, announced, format = r.stepFacts(dir, session.Tag, since)
	facts.Awaits = r.awaitedCi(dir, session.Tag, since)
	if !facts.TagExists {
		facts.Format = format
		facts.ChangelogScope = r.changelogScope(ctx, dir, p, session)
		facts.Notes = r.notesPath(ctx, dir, p, session.Tag, announced, since)
		facts.NotesDrafted = facts.Notes != "" && facts.Session != nil && writtenSince(facts.Notes, since)
		if releasesByPr(p) {
			facts.ReleasePr = r.releasePrOf(ctx, dir, session.Tag)
		}
		return facts, nil
	}
	facts.OnTrunk = r.onTrunk(ctx, dir, trunkRef, session.Tag)
	if releasesByPr(p) && !facts.OnTrunk {
		releaseRef := "origin/" + molten.ResolvedBranches(dir).Release
		if _, err := r.git(ctx, dir, "git", "merge-base", "--is-ancestor", session.Tag, releaseRef); err != nil {
			facts.OffRelease = true
		}
	}
	r.readGithubRelease(ctx, dir, &facts)
	if !facts.NoGithub {
		r.readTagWorkflows(ctx, dir, &facts)
	}
	return facts, nil
}

// changelogScope reads where the release's changelog sections start, in the release worktree; nil when no manual step
// of its channel writes one, or when it cannot be read.
func (r *Runs) changelogScope(ctx context.Context, dir string, p *molten.Pipeline, session ReleaseSession) *ReleaseChangelogScope {
	scope := &ReleaseChangelogScope{Steps: []string{}}
	for _, step := range channelSteps(p, session.Channel) {
		if molten.ChangelogOfStep(step, molten.DeclaredChangelogs(p)) != "" {
			scope.Steps = append(scope.Steps, step.Id)
		}
	}
	if len(scope.Steps) == 0 {
		return nil
	}
	env := release.Env{Dir: r.manualCheckDir(dir), Run: release.Runner(r.git)}
	since, err := env.ChangelogSince(ctx, session.Tag)
	if err != nil {
		return nil
	}
	scope.Since = since
	return scope
}

// checkFollowed refuses an action on a release other than the one followed.
func (r *Runs) checkFollowed(dir string, p *molten.Pipeline, tag string) (ReleaseSession, error) {
	ctx, cancel := context.WithTimeout(context.Background(), releaseGitTimeout)
	defer cancel()
	session, ok := r.followedRelease(ctx, dir, p)
	if !ok || session.Tag != tag {
		return session, errNotFollowed(tag)
	}
	return session, nil
}

// manualStepOf tells whether a release step with this id, in either channel, is a manual one.
func manualStepOf(p *molten.Pipeline, id string) bool {
	if p == nil || p.Release == nil {
		return false
	}
	for _, steps := range [][]molten.PipelineStep{p.Release.Rc, p.Release.Public} {
		for _, s := range steps {
			if s.Id == id && s.IsManual() {
				return true
			}
		}
	}
	return false
}

// RunReleaseStep runs a declared step of the release followed, or its preparation again (ReleasePreparationStepId);
// one at a time.
func (r *Runs) RunReleaseStep(req ReleaseStepRequest) (RunResult, error) {
	if err := checkDir(req.Dir); err != nil {
		return RunResult{}, err
	}
	dir := filepath.Clean(req.Dir)
	project := canonicalRunDir(dir)
	p, err := validPipelineAt(project)
	if err != nil {
		return RunResult{}, err
	}
	// A manual step runs nothing, so marking it done never waits for the commands' trust (#1091); every other step
	// does.
	untrusted := r.untrustedIn(dir, p)
	if untrusted != nil && !manualStepOf(p, req.Step) {
		return RunResult{Untrusted: untrusted}, nil
	}
	release, held := r.reserveAdmission(project, RunKindRelease, req.Tag)
	if release == nil {
		return RunResult{}, errStillRunning(held)
	}
	defer release()
	r.projectDirsAt(dir, project)
	session, err := r.checkFollowed(project, p, req.Tag)
	if err != nil {
		return RunResult{}, err
	}
	if running := r.runningOf(project, RunKindRelease); running != nil {
		return RunResult{}, errStillRunning(running.Title)
	}
	steps := channelSteps(p, session.Channel)
	var rec RunRecord
	if req.Step == ReleasePreparationStepId {
		if untrusted != nil {
			return RunResult{Untrusted: untrusted}, nil
		}
		if len(molten.ReleasePreparation(steps)) == 0 {
			return RunResult{}, uimsg.Errorf(uimsg.Make("mission.release.noPreparation"), "the pipeline declares no preparation")
		}
		rec, err = r.launchPreparationAt(dir, project, steps, session)
		return RunResult{Run: &rec}, err
	}
	for _, step := range steps {
		if step.Id != req.Step {
			continue
		}
		if step.IsManual() {
			unproved := r.checkManualStep(project, p, step, session)
			if unproved != nil && !req.Force {
				return RunResult{Unproved: unproved}, nil
			}
			rec, err = r.recordManualStep(dir, project, step, session, unproved)
			return RunResult{Run: &rec}, err
		}
		if untrusted != nil {
			return RunResult{Untrusted: untrusted}, nil
		}
		run, err := expandRelease(step.Run, session.Version, session.Tag, currentBranch(r.git, project))
		if err != nil {
			return RunResult{}, err
		}
		command := TrustedCommand{Kind: RunKindRelease, Id: step.Id, Title: expandReleaseText(step.Title, session), Cwd: step.Cwd, Env: step.Env, Run: run}
		rec, err = r.launchAt(dir, project, command, "", "", session.Tag)
		return RunResult{Run: &rec}, err
	}
	return RunResult{}, uimsg.Errorf(uimsg.Make("mission.release.noStep", "channel", session.Channel, "step", req.Step), "the pipeline declares no release.%s step %q", session.Channel, req.Step)
}

// RerunFailedJobs reruns the failed jobs of the newest GitHub run the release's tag started.
func (r *Runs) RerunFailedJobs(dir string, tag string) error {
	facts, err := r.ReleaseFactsOf(dir)
	if err != nil {
		return err
	}
	if facts.Tag != tag || len(facts.Runs) == 0 {
		return uimsg.Errorf(uimsg.Make("mission.release.noRerun", "tag", tag), "no GitHub run of %s to rerun", tag)
	}
	ctx, cancel := context.WithTimeout(context.Background(), releaseFactsTimeout)
	defer cancel()
	_, err = r.git(ctx, filepath.Clean(dir), "gh", "run", "rerun", strconv.FormatInt(facts.Runs[0].DatabaseId, 10), "--failed")
	return err
}

func (r *Runs) releaseNotesPath(dir string, tag string) (string, error) {
	facts, err := r.ReleaseFactsOf(dir)
	if err != nil {
		return "", err
	}
	if facts.Tag != tag {
		return "", errNotFollowed(tag)
	}
	if facts.Notes == "" {
		return "", uimsg.Errorf(uimsg.Make("mission.release.noNotes"), "no public notes are drafted for this release")
	}
	return facts.Notes, nil
}

// ReadReleaseNotes returns the public notes drafted for the cut.
func (r *Runs) ReadReleaseNotes(dir string, tag string) (ReleaseNotes, error) {
	path, err := r.releaseNotesPath(dir, tag)
	if err != nil {
		return ReleaseNotes{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ReleaseNotes{}, err
	}
	if len(data) > maxReleaseNotesBytes {
		return ReleaseNotes{}, uimsg.Errorf(uimsg.Make("mission.release.notesTooLarge", "path", path), "%s is too large to edit here", path)
	}
	return ReleaseNotes{Path: path, Text: string(data)}, nil
}

// SaveReleaseNotes writes the public notes as edited, before the cut. A repository can commit its notes file, or a
// folder on its path, as a symbolic link (notes/v1.md -> ~/.zshrc): the notes are only written over a regular file
// whose folder resolves inside the project or one of its repository's worktrees, and replaced by a rename, which never
// follows a link (#662).
func (r *Runs) SaveReleaseNotes(dir string, tag string, text string) error {
	path, err := r.releaseNotesPath(dir, tag)
	if err != nil {
		return err
	}
	info, err := r.checkNotesTarget(dir, path)
	if err != nil {
		return err
	}
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	return replaceFile(path, []byte(text), info.Mode().Perm())
}

func (r *Runs) checkNotesTarget(dir string, path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, uimsg.Errorf(uimsg.Make("mission.release.notesLink", "path", path), "%s is not a regular file: release notes are not written through a link", path)
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	for _, root := range r.notesRoots(dir) {
		if pathWithin(root, parent) {
			return info, nil
		}
	}
	return nil, uimsg.Errorf(uimsg.Make("mission.release.notesOutside", "path", path), "%s is outside the project: release notes are not written there", path)
}

// notesRoots: the project and its repository's worktrees, links resolved.
func (r *Runs) notesRoots(dir string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), releaseFactsTimeout)
	defer cancel()
	roots := []string{dir}
	g := &gitReader{ctx: ctx, run: r.git, dir: dir}
	for _, line := range g.lines("worktree", "list", "--porcelain") {
		if worktree, ok := strings.CutPrefix(line, "worktree "); ok {
			roots = append(roots, worktree)
		}
	}
	var resolved []string
	for _, root := range roots {
		if real, err := filepath.EvalSymlinks(root); err == nil {
			resolved = append(resolved, real)
		}
	}
	return resolved
}

func pathWithin(root string, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && !filepath.IsAbs(rel) && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// replaceFile writes beside path, then renames over it: a link put in its place meanwhile is replaced, not followed.
func replaceFile(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
