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
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// A release launched from the Project tab (FR-MC-015), as in Notulia: the session records which release is on its way,
// and starting it runs the pipeline's preparation at once; every later step waits for the user's click (FR-MC-016).
// The session lives beside the project's runs, in <data>/molten/runs/<project>/release.json.

const (
	RunKindRelease = "release"

	ReleaseChannelRc     = "rc"
	ReleaseChannelPublic = "public"

	ReleaseSessionFileName = "release.json"
	// The tags cut at the terminal the user stopped following.
	ReleaseIgnoredFileName = "release-ignored.json"
	maxIgnoredReleases     = 20
	// The preparation's run, kept apart from the declared steps: no step id may start with "@", so a project's own
	// step (Notulia's "prepare") is never read as the preparation, nor the preparation as it (#230).
	ReleasePreparationStepId = "@preparation"

	releaseGitTimeout = 15 * time.Second
)

type ReleaseSession struct {
	Tag       string `json:"tag"`
	Version   string `json:"version"`
	Channel   string `json:"channel"`
	StartedAt int64  `json:"startedat"`
}

type ReleaseStartRequest struct {
	Dir     string `json:"dir"`
	Channel string `json:"channel"`
	Tag     string `json:"tag"`
}

type ReleaseStartResult struct {
	Session   *ReleaseSession `json:"session,omitempty"`
	Run       *RunRecord      `json:"run,omitempty"`
	Untrusted *UntrustedInfo  `json:"untrusted,omitempty"`
}

func (r *Runs) releaseSessionFile(dir string) string {
	return filepath.Join(r.projectDir(dir), ReleaseSessionFileName)
}

// ReleaseSessionOf returns the release on its way, or nil; light enough for the header to ask often.
func (r *Runs) ReleaseSessionOf(dir string) (*ReleaseSession, error) {
	if err := checkDir(dir); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(r.releaseSessionFile(filepath.Clean(dir)))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var session ReleaseSession
	if err := json.Unmarshal(data, &session); err != nil || session.Tag == "" {
		return nil, nil
	}
	return &session, nil
}

func (r *Runs) writeReleaseSession(dir string, session ReleaseSession) error {
	if err := os.MkdirAll(r.projectDir(dir), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(session, "", "  ")
	if err != nil {
		return err
	}
	file := r.releaseSessionFile(dir)
	if err := os.WriteFile(file+".tmp", data, 0600); err != nil {
		return err
	}
	return os.Rename(file+".tmp", file)
}

// EndRelease stops following the release on its way; nothing already pushed or published is undone.
func (r *Runs) EndRelease(dir string) error {
	if err := checkDir(dir); err != nil {
		return err
	}
	err := os.Remove(r.releaseSessionFile(filepath.Clean(dir)))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (r *Runs) ignoredReleases(dir string) []string {
	var tags []string
	readJson(filepath.Join(r.projectDir(dir), ReleaseIgnoredFileName), &tags)
	return tags
}

// IgnoreRelease stops following a tag cut at the terminal; nothing is undone.
func (r *Runs) IgnoreRelease(dir string, tag string) error {
	if err := checkDir(dir); err != nil {
		return err
	}
	dir = filepath.Clean(dir)
	tags := append(r.ignoredReleases(dir), tag)
	tags = tags[max(0, len(tags)-maxIgnoredReleases):]
	if err := os.MkdirAll(r.projectDir(dir), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(tags)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(r.projectDir(dir), ReleaseIgnoredFileName), data, 0600)
}

// StopFollowing ends the release launched from the Project tab, or else stops following the tag cut at the terminal.
func (r *Runs) StopFollowing(dir string, tag string) error {
	if session, _ := r.ReleaseSessionOf(dir); session != nil || tag == "" {
		return r.EndRelease(dir)
	}
	return r.IgnoreRelease(dir, tag)
}

// releaseVersion reads a release tag: its version without the prefix, and whether it is a release candidate.
func releaseVersion(p *molten.Pipeline, tag string) (string, bool, error) {
	rules := versions.Rules{TagPrefix: versions.DefaultTagPrefix}
	if p.Versions != nil {
		rules.FirstPublic = p.Versions.FirstPublic
		if p.Versions.TagPrefix != "" {
			rules.TagPrefix = p.Versions.TagPrefix
		}
	}
	v, ok := rules.ReleaseOf(tag)
	if !ok || strings.TrimSpace(tag) != tag {
		return "", false, fmt.Errorf("%q is not a release tag (%sX.Y.Z or %sX.Y.Z-N)", tag, rules.TagPrefix, rules.TagPrefix)
	}
	return v.Base().String(), v.IsRc(), nil
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func expandRelease(run string, version string, tag string, branch string) (string, error) {
	return expandCommand(run, CommandVars{Version: version, Tag: tag, Branch: branch})
}

// preparationCommand chains the preparation steps in one shell: each announced as a phase, in its own folder and
// with its own variables; the first failure stops the rest.
func preparationCommand(steps []molten.PipelineStep, version string, tag string, branch string) (string, error) {
	var parts []string
	for _, step := range steps {
		var line strings.Builder
		fmt.Fprintf(&line, "echo %s && (", shellQuote("▶ phase: "+step.Id))
		if step.Cwd != "" {
			fmt.Fprintf(&line, "cd %s && ", shellQuote(step.Cwd))
		}
		keys := make([]string, 0, len(step.Env))
		for k := range step.Env {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(&line, "export %s=%s && ", k, shellQuote(step.Env[k]))
		}
		expanded, err := expandRelease(step.Run, version, tag, branch)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(&line, "%s )", expanded)
		parts = append(parts, line.String())
	}
	return strings.Join(parts, " && "), nil
}

// tagExists tells whether the tag is cut: on origin, as Notulia reads it, since a cut whose push failed leaves a local
// tag that is not one. The local tag counts only for a project without an origin, or while origin cannot be reached.
func (r *Runs) tagExists(dir string, tag string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), releaseGitTimeout)
	defer cancel()
	if _, err := r.git(ctx, dir, "git", "remote", "get-url", "origin"); err == nil {
		out, err := r.git(ctx, dir, "git", "ls-remote", "--tags", "--refs", "origin", "refs/tags/"+tag)
		if err == nil {
			return strings.Contains(string(out), "refs/tags/"+tag)
		}
	}
	_, err := r.git(ctx, dir, "git", "rev-parse", "-q", "--verify", "refs/tags/"+tag)
	return err == nil
}

// StartRelease records the release on its way and runs the pipeline's preparation; a second release is refused while
// one is in flight.
func (r *Runs) StartRelease(req ReleaseStartRequest) (ReleaseStartResult, error) {
	if err := checkDir(req.Dir); err != nil {
		return ReleaseStartResult{}, err
	}
	dir := filepath.Clean(req.Dir)
	p, untrusted, err := r.trustedPipeline(dir)
	if err != nil || untrusted != nil {
		return ReleaseStartResult{Untrusted: untrusted}, err
	}
	if req.Channel != ReleaseChannelRc && req.Channel != ReleaseChannelPublic {
		return ReleaseStartResult{}, fmt.Errorf("not a release channel: %q", req.Channel)
	}
	steps := channelSteps(p, req.Channel)
	if len(steps) == 0 {
		return ReleaseStartResult{}, fmt.Errorf("the pipeline declares no release.%s steps", req.Channel)
	}
	version, isRc, err := releaseVersion(p, req.Tag)
	if err != nil {
		return ReleaseStartResult{}, err
	}
	if isRc && req.Channel == ReleaseChannelPublic {
		return ReleaseStartResult{}, fmt.Errorf("%s is a release candidate's tag, not a public release's", req.Tag)
	}
	if !isRc && req.Channel == ReleaseChannelRc {
		return ReleaseStartResult{}, fmt.Errorf("%s is a public release's tag, not a release candidate's", req.Tag)
	}
	if session, _ := r.ReleaseSessionOf(dir); session != nil {
		return ReleaseStartResult{}, fmt.Errorf("a release is already on its way: %s", session.Tag)
	}
	if running := r.runningOf(dir, RunKindRelease); running != nil {
		return ReleaseStartResult{}, fmt.Errorf("%s is still running", running.Title)
	}
	if r.tagExists(dir, req.Tag) {
		return ReleaseStartResult{}, fmt.Errorf("%s is already tagged", req.Tag)
	}
	session := ReleaseSession{Tag: req.Tag, Version: version, Channel: req.Channel, StartedAt: r.now().UnixMilli()}
	if err := r.writeReleaseSession(dir, session); err != nil {
		return ReleaseStartResult{}, err
	}
	if len(molten.ReleasePreparation(steps)) == 0 {
		return ReleaseStartResult{Session: &session}, nil
	}
	rec, err := r.launchPreparation(dir, steps, session)
	if err != nil {
		// No release is announced that nothing runs for.
		r.EndRelease(dir)
		return ReleaseStartResult{}, err
	}
	return ReleaseStartResult{Session: &session, Run: &rec}, nil
}

// trustedPipeline reads the project's valid pipeline; untrusted commands are returned for the user to review.
func (r *Runs) trustedPipeline(dir string) (*molten.Pipeline, *UntrustedInfo, error) {
	report := molten.ValidatePipeline(dir)
	if !report.Valid {
		if !report.Present {
			return nil, nil, errors.New("the project has no pipeline (.molten/project.json)")
		}
		return nil, nil, fmt.Errorf("the pipeline has problems: %s", strings.Join(report.Errors, "; "))
	}
	commands := PipelineCommands(report.Pipeline)
	hash := CommandsHash(commands)
	if !r.trust.IsTrusted(dir, hash) {
		return nil, &UntrustedInfo{Hash: hash, Commands: commands}, nil
	}
	return report.Pipeline, nil, nil
}

func channelSteps(p *molten.Pipeline, channel string) []molten.PipelineStep {
	if p == nil || p.Release == nil {
		return nil
	}
	switch channel {
	case ReleaseChannelRc:
		return p.Release.Rc
	case ReleaseChannelPublic:
		return p.Release.Public
	}
	return nil
}

func (r *Runs) launchPreparation(dir string, steps []molten.PipelineStep, session ReleaseSession) (RunRecord, error) {
	run, err := preparationCommand(molten.ReleasePreparation(steps), session.Version, session.Tag, currentBranch(r.git, dir))
	if err != nil {
		return RunRecord{}, err
	}
	command := TrustedCommand{
		Kind:  RunKindRelease,
		Id:    ReleasePreparationStepId,
		Title: "Prepare " + session.Tag,
		Run:   run,
	}
	return r.launch(dir, command, "", "", session.Tag)
}
