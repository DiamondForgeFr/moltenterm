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
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// A release launched from the Timeline (FR-MC-015), as in Notulia: the session records which release is on its way,
// and starting it runs the pipeline's preparation at once; every later step waits for the user's click (FR-MC-016).
// The session lives beside the project's runs, in <data>/molten/runs/<project>/release.json.

const (
	RunKindRelease = "release"

	ReleaseChannelRc     = "rc"
	ReleaseChannelPublic = "public"

	ReleaseSessionFileName = "release.json"
	ReleasePrepareStepId   = "prepare"

	releaseGitTimeout = 15 * time.Second
)

var releaseVersionRegex = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([1-9]\d*))?$`)

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

// releaseVersion reads a release tag: its version without the prefix, and whether it is a release candidate.
func releaseVersion(p *molten.Pipeline, tag string) (string, bool, error) {
	prefix := "v"
	if p.Versions != nil && p.Versions.TagPrefix != "" {
		prefix = p.Versions.TagPrefix
	}
	m := releaseVersionRegex.FindStringSubmatch(strings.TrimPrefix(tag, prefix))
	if !strings.HasPrefix(tag, prefix) || m == nil {
		return "", false, fmt.Errorf("%q is not a release tag (%sX.Y.Z or %sX.Y.Z-N)", tag, prefix, prefix)
	}
	return m[1] + "." + m[2] + "." + m[3], m[4] != "", nil
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func expandRelease(run string, version string, tag string) string {
	return strings.NewReplacer("{version}", version, "{tag}", tag).Replace(run)
}

// preparationCommand chains the preparation steps in one shell: each announced as a phase, in its own folder and
// with its own variables; the first failure stops the rest.
func preparationCommand(steps []molten.PipelineStep, version string, tag string) string {
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
		fmt.Fprintf(&line, "%s )", expandRelease(step.Run, version, tag))
		parts = append(parts, line.String())
	}
	return strings.Join(parts, " && ")
}

func (r *Runs) tagExists(dir string, tag string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), releaseGitTimeout)
	defer cancel()
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
	report := molten.ValidatePipeline(dir)
	if !report.Valid {
		if !report.Present {
			return ReleaseStartResult{}, errors.New("the project has no pipeline (.molten/project.json)")
		}
		return ReleaseStartResult{}, fmt.Errorf("the pipeline has problems: %s", strings.Join(report.Errors, "; "))
	}
	commands := PipelineCommands(report.Pipeline)
	hash := CommandsHash(commands)
	if !r.trust.IsTrusted(dir, hash) {
		return ReleaseStartResult{Untrusted: &UntrustedInfo{Hash: hash, Commands: commands}}, nil
	}
	var steps []molten.PipelineStep
	if report.Pipeline.Release != nil {
		switch req.Channel {
		case ReleaseChannelRc:
			steps = report.Pipeline.Release.Rc
		case ReleaseChannelPublic:
			steps = report.Pipeline.Release.Public
		}
	}
	if req.Channel != ReleaseChannelRc && req.Channel != ReleaseChannelPublic {
		return ReleaseStartResult{}, fmt.Errorf("not a release channel: %q", req.Channel)
	}
	if len(steps) == 0 {
		return ReleaseStartResult{}, fmt.Errorf("the pipeline declares no release.%s steps", req.Channel)
	}
	version, isRc, err := releaseVersion(report.Pipeline, req.Tag)
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
	command := TrustedCommand{
		Kind:  RunKindRelease,
		Id:    ReleasePrepareStepId,
		Title: "Prepare " + req.Tag,
		Run:   preparationCommand(molten.ReleasePreparation(steps), version, req.Tag),
	}
	rec, err := r.launch(dir, command, "", "")
	if err != nil {
		// No release is announced that nothing runs for.
		r.EndRelease(dir)
		return ReleaseStartResult{}, err
	}
	return ReleaseStartResult{Session: &session, Run: &rec}, nil
}
