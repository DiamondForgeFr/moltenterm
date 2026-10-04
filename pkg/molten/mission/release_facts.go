// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// What the release panel reads (FR-MC-016), as Notulia's dev_release_facts: the panel derives the phases from these
// facts and stores none of them, so a release cut at the terminal, or followed across a restart, reads exactly like one
// launched from the Timeline. Only the intent of a release launched here (the session) is written down.

const (
	// A tag cut at the terminal is followed while it is this young.
	releaseFollowTerminal = 3 * 24 * time.Hour
	releaseFactsTimeout   = 30 * time.Second
	releaseTailLines      = 6
	maxReleaseNotesBytes  = 256 << 10
)

var notesRegex = regexp.MustCompile(`(?m)^\s*▶ notes:\s*(.+?)\s*$`)

// The last run of a declared release step for the release followed.
type ReleaseStepFact struct {
	RunId   string   `json:"runid"`
	State   string   `json:"state"`
	Running bool     `json:"running"`
	Exit    *int     `json:"exit,omitempty"`
	Tail    []string `json:"tail"`
	Phases  []string `json:"phases"`
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
	// The release launched from the Timeline; nil for a tag cut at the terminal.
	Session   *ReleaseSession            `json:"session,omitempty"`
	Tag       string                     `json:"tag,omitempty"`
	Version   string                     `json:"version,omitempty"`
	Channel   string                     `json:"channel,omitempty"`
	TagExists bool                       `json:"tagexists"`
	Trunk     string                     `json:"trunk,omitempty"`
	Steps     map[string]ReleaseStepFact `json:"steps"`
	// The public notes drafted for the cut, while the tag is not pushed yet.
	Notes string `json:"notes,omitempty"`
	// GitHub, through the user's gh: the runs the tag started, the newest one's jobs, the release.
	GithubError string            `json:"githuberror,omitempty"`
	Runs        []ReleaseGhRun    `json:"runs"`
	Jobs        []ReleaseGhJob    `json:"jobs"`
	Release     *ReleaseGhRelease `json:"release,omitempty"`
	// The release commit is on the trunk, or a pull request carries it back.
	OnTrunk bool       `json:"ontrunk"`
	BackPr  *ReleasePr `json:"backpr,omitempty"`
}

type ReleaseStepRequest struct {
	Dir  string `json:"dir"`
	Tag  string `json:"tag"`
	Step string `json:"step"`
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

// followedRelease is the release launched from the Timeline, or else the newest release tag when it was cut lately.
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

// stepFacts reads the last run of each release step for the tag, by step id ("prepare" for the preparation).
func (r *Runs) stepFacts(dir string, tag string) (map[string]ReleaseStepFact, string) {
	facts := map[string]ReleaseStepFact{}
	notes := ""
	runs := r.List(dir)
	// Oldest first, so that the newest run of a step, and the newest notes announced, win.
	for i := len(runs) - 1; i >= 0; i-- {
		rec := runs[i]
		if rec.Kind != RunKindRelease || rec.Tag != tag {
			continue
		}
		data, _ := os.ReadFile(r.logFile(dir, rec.Id))
		fact := ReleaseStepFact{RunId: rec.Id, State: rec.State, Running: rec.State == RunStateRunning, Exit: rec.Exit, Phases: rec.Phases, Tail: []string{}}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimRight(line, "\r")
			if strings.TrimSpace(line) == "" || exitRegex.MatchString(line) || notesRegex.MatchString(line) {
				continue
			}
			fact.Tail = append(fact.Tail, line)
		}
		fact.Tail = fact.Tail[max(0, len(fact.Tail)-releaseTailLines):]
		facts[rec.StepId] = fact
		if m := notesRegex.FindAllSubmatch(data, -1); len(m) > 0 {
			path := expandHome(string(m[len(m)-1][1]))
			if !filepath.IsAbs(path) {
				path = filepath.Join(dir, rec.Cwd, path)
			}
			notes = filepath.Clean(path)
		}
	}
	return facts, notes
}

// notesPath is where the public notes of the cut are: those a step announced, or else the project's versions.notes.
func notesPath(dir string, p *molten.Pipeline, tag string, announced string) string {
	if announced != "" {
		return announced
	}
	if p.Versions == nil || p.Versions.Notes == "" {
		return ""
	}
	return filepath.Join(dir, strings.ReplaceAll(p.Versions.Notes, "{tag}", tag))
}

func (r *Runs) readGithubRelease(ctx context.Context, dir string, facts *ReleaseFacts) {
	out, err := ghJson(ctx, r.git, dir, "run", "list", "--limit", "30", "--json", "databaseId,workflowName,headBranch,status,conclusion,url,createdAt")
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
			if strings.Contains(pr.HeadRefName, facts.Version) || strings.Contains(pr.Title, facts.Tag) {
				facts.BackPr = &pr
				break
			}
		}
	}
}

// onTrunk tells whether the tagged commit's change is on the trunk: merged, or carried back by a cherry-pick.
func (r *Runs) onTrunk(ctx context.Context, dir string, trunkRef string, tag string) bool {
	if trunkRef == "" {
		return false
	}
	out, err := r.git(ctx, dir, "git", "cherry", trunkRef, tag, tag+"^")
	if err != nil {
		return false
	}
	return !strings.Contains(string(out), "+")
}

// ReleaseFactsOf reads every fact the release panel derives the phases from; no release followed gives empty facts.
func (r *Runs) ReleaseFactsOf(dir string) (ReleaseFacts, error) {
	facts := ReleaseFacts{Steps: map[string]ReleaseStepFact{}, Runs: []ReleaseGhRun{}, Jobs: []ReleaseGhJob{}}
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
	if stored, _ := r.ReleaseSessionOf(dir); stored != nil {
		facts.Session = stored
	}
	facts.Tag, facts.Version, facts.Channel = session.Tag, session.Version, session.Channel
	facts.TagExists = r.tagExists(dir, session.Tag)
	trunk, trunkRef := resolveTrunk(ctx, r.git, dir)
	facts.Trunk = trunk
	var announced string
	facts.Steps, announced = r.stepFacts(dir, session.Tag)
	if !facts.TagExists {
		if path := notesPath(dir, p, session.Tag, announced); path != "" {
			if info, err := os.Stat(path); err == nil && !info.IsDir() {
				facts.Notes = path
			}
		}
		return facts, nil
	}
	facts.OnTrunk = r.onTrunk(ctx, dir, trunkRef, session.Tag)
	r.readGithubRelease(ctx, dir, &facts)
	return facts, nil
}

// checkFollowed refuses an action on a release other than the one followed.
func (r *Runs) checkFollowed(dir string, p *molten.Pipeline, tag string) (ReleaseSession, error) {
	ctx, cancel := context.WithTimeout(context.Background(), releaseGitTimeout)
	defer cancel()
	session, ok := r.followedRelease(ctx, dir, p)
	if !ok || session.Tag != tag {
		return session, fmt.Errorf("%s is not the release followed", tag)
	}
	return session, nil
}

// RunReleaseStep runs a declared step of the release followed, or its preparation again ("prepare"); one at a time.
func (r *Runs) RunReleaseStep(req ReleaseStepRequest) (RunResult, error) {
	if err := checkDir(req.Dir); err != nil {
		return RunResult{}, err
	}
	dir := filepath.Clean(req.Dir)
	p, untrusted, err := r.trustedPipeline(dir)
	if err != nil || untrusted != nil {
		return RunResult{Untrusted: untrusted}, err
	}
	session, err := r.checkFollowed(dir, p, req.Tag)
	if err != nil {
		return RunResult{}, err
	}
	if running := r.runningOf(dir, RunKindRelease); running != nil {
		return RunResult{}, fmt.Errorf("%s is still running", running.Title)
	}
	steps := channelSteps(p, session.Channel)
	var rec RunRecord
	if req.Step == ReleasePrepareStepId {
		rec, err = r.launchPreparation(dir, steps, session)
		return RunResult{Run: &rec}, err
	}
	for _, step := range steps {
		if step.Id != req.Step {
			continue
		}
		command := TrustedCommand{Kind: RunKindRelease, Id: step.Id, Title: step.Title, Cwd: step.Cwd, Env: step.Env,
			Run: expandRelease(step.Run, session.Version, session.Tag, currentBranch(r.git, dir))}
		rec, err = r.launch(dir, command, "", "", session.Tag)
		return RunResult{Run: &rec}, err
	}
	return RunResult{}, fmt.Errorf("the pipeline declares no release.%s step %q", session.Channel, req.Step)
}

// RerunFailedJobs reruns the failed jobs of the newest GitHub run the release's tag started.
func (r *Runs) RerunFailedJobs(dir string, tag string) error {
	facts, err := r.ReleaseFactsOf(dir)
	if err != nil {
		return err
	}
	if facts.Tag != tag || len(facts.Runs) == 0 {
		return fmt.Errorf("no GitHub run of %s to rerun", tag)
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
		return "", fmt.Errorf("%s is not the release followed", tag)
	}
	if facts.Notes == "" {
		return "", errors.New("no public notes are drafted for this release")
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
		return ReleaseNotes{}, fmt.Errorf("%s is too large to edit here", path)
	}
	return ReleaseNotes{Path: path, Text: string(data)}, nil
}

// SaveReleaseNotes writes the public notes as edited, before the cut.
func (r *Runs) SaveReleaseNotes(dir string, tag string, text string) error {
	path, err := r.releaseNotesPath(dir, tag)
	if err != nil {
		return err
	}
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	return os.WriteFile(path, []byte(text), 0644)
}
