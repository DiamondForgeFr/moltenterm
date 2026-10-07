// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package release cuts a project's releases from its `.molten/project.json` (FR-REL-002, DS-REL-002): the commands
// behind `molten release`, which a project's release.rc and release.public steps call so that Mission Control runs
// them. They follow Notulia's chain (scripts/promote.mjs, release.sh, pipeline-step.sh): promote the trunk onto the
// release branch once its CI is green, prepare the cut beside the checkout (bump, notes), finalize it (commit, tag,
// atomic push), carry the release commit back to the trunk, close the milestone of a public release.
//
// Nothing here is specific to one project: the branches, the version files, the tag prefix and the notes path come
// from the project. Every command is non-interactive, says why on its last line when it fails, and can be run again
// after a failure: the release worktree is reset on every run.
package release

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

const (
	DefaultTrunk         = "develop"
	DefaultReleaseBranch = "main"
	DefaultNotesPath     = "releases/{tag}.md"

	// The release worktree sits beside the checkout, as Notulia's ../<repo>-release: the checkout the developer works
	// in is never touched.
	ReleaseWorktreeSuffix = "-release"

	// Mission Control opens the file this line names for editing before the cut (the release contract).
	NotesMarker = "▶ notes: "

	SyncBackBranchPrefix = "chore/sync-back-"

	ciPollInterval = 30 * time.Second
	ciWaitLimit    = 90 * time.Minute
)

// Runner runs a program in a folder and returns its standard output; the error carries the program's last error line.
// Tests replace gh with their own.
type Runner func(ctx context.Context, dir string, name string, args ...string) ([]byte, error)

// Env is where a release command runs: the project folder (its checkout, or any worktree of its repository) and the
// programs it calls.
type Env struct {
	Dir string
	Run Runner
	Out io.Writer
	// IsGithub tells whether the project's origin is on GitHub: off GitHub, there is no CI to wait for, no pull request
	// to open and no milestone to close. nil reads origin's URL.
	IsGithub func(ctx context.Context) bool
	Sleep    func(time.Duration)
	Now      func() time.Time
	// Zero means the defaults (30 s, 90 min).
	CiPoll  time.Duration
	CiLimit time.Duration
}

// Project is what the release commands read from `.molten/project.json`.
type Project struct {
	Root    string
	Rules   versions.Rules
	Files   []versions.VersionFile
	Notes   string
	Trunk   string
	Release string
}

func (e *Env) printf(format string, args ...any) {
	if e.Out == nil {
		return
	}
	fmt.Fprintf(e.Out, format, args...)
}

func (e *Env) sleep(d time.Duration) {
	if e.Sleep != nil {
		e.Sleep(d)
		return
	}
	time.Sleep(d)
}

func (e *Env) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

// ExecRunner runs programs with the process's PATH; nothing may wait for a password or a prompt.
func ExecRunner(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "NO_COLOR=1")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		if lines := strings.Split(msg, "\n"); msg != "" {
			msg = strings.TrimSpace(lines[len(lines)-1])
		}
		if msg == "" {
			msg = err.Error()
		}
		return stdout.Bytes(), fmt.Errorf("%s %s: %s", name, strings.Join(args, " "), msg)
	}
	return stdout.Bytes(), nil
}

func (e *Env) run(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	run := e.Run
	if run == nil {
		run = ExecRunner
	}
	return run(ctx, dir, name, args...)
}

func (e *Env) git(ctx context.Context, dir string, args ...string) (string, error) {
	out, err := e.run(ctx, dir, "git", args...)
	return strings.TrimSpace(string(out)), err
}

func (e *Env) gitLines(ctx context.Context, dir string, args ...string) ([]string, error) {
	out, err := e.git(ctx, dir, args...)
	if err != nil || out == "" {
		return nil, err
	}
	return strings.Split(out, "\n"), nil
}

func (e *Env) gh(ctx context.Context, dir string, args ...string) ([]byte, error) {
	return e.run(ctx, dir, "gh", args...)
}

func (e *Env) onGithub(ctx context.Context, root string) bool {
	if e.IsGithub != nil {
		return e.IsGithub(ctx)
	}
	url, err := e.git(ctx, root, "remote", "get-url", "origin")
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(url), "github")
}

// LoadProject reads the project of the folder: its git root, its numbering, its version files and its branches.
func (e *Env) LoadProject(ctx context.Context) (*Project, error) {
	root, err := e.git(ctx, e.Dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, fmt.Errorf("%s is not in a git repository", e.Dir)
	}
	report := molten.ValidatePipeline(root)
	if !report.Present {
		return nil, fmt.Errorf("%s has no %s", root, molten.ProjectPipelineFile)
	}
	if !report.Valid {
		return nil, fmt.Errorf("%s is not valid: %s (molten project validate)", molten.ProjectPipelineFile, strings.Join(report.Errors, "; "))
	}
	p := &Project{Root: root, Rules: versions.Rules{TagPrefix: versions.DefaultTagPrefix}, Notes: DefaultNotesPath}
	if v := report.Pipeline.Versions; v != nil {
		if v.TagPrefix != "" {
			p.Rules.TagPrefix = v.TagPrefix
		}
		p.Rules.FirstPublic = v.FirstPublic
		if v.Notes != "" {
			p.Notes = v.Notes
		}
		p.Files = v.Files
	}
	branches := molten.ConfiguredBranches(root)
	p.Trunk, p.Release = branches.Trunk, branches.Release
	if p.Trunk == "" {
		p.Trunk = DefaultTrunk
	}
	if p.Release == "" {
		p.Release = DefaultReleaseBranch
	}
	return p, nil
}

// NotesFile is the notes path of a tag, relative to the project's root.
func (p *Project) NotesFile(tag string) string {
	return strings.ReplaceAll(p.Notes, "{tag}", tag)
}

// releaseOf reads a tag as one of the project's releases, refusing anything else: the tag goes into git commands and
// a commit message.
func (p *Project) releaseOf(tag string) (versions.Version, string, error) {
	v, ok := p.Rules.ReleaseOf(tag)
	if !ok || strings.TrimSpace(tag) != tag {
		prefix := p.Rules.TagPrefix
		return versions.Version{}, "", fmt.Errorf("%q is not a release tag of this project (%sX.Y.Z or %sX.Y.Z-N)", tag, prefix, prefix)
	}
	if v.IsRc() {
		return v, versions.ChannelRc, nil
	}
	return v, versions.ChannelPublic, nil
}

// commonDir is the repository's shared git folder, whichever worktree the command runs in.
func (e *Env) commonDir(ctx context.Context, root string) (string, error) {
	dir, err := e.git(ctx, root, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return "", err
	}
	return filepath.Clean(dir), nil
}

// ReleaseWorktree is the folder the cut is prepared in: beside the repository's main checkout, named after it.
func (e *Env) ReleaseWorktree(ctx context.Context, root string) (string, error) {
	common, err := e.commonDir(ctx, root)
	if err != nil {
		return "", err
	}
	main := common
	if filepath.Base(common) == ".git" {
		main = filepath.Dir(common)
	}
	return filepath.Join(filepath.Dir(main), filepath.Base(main)+ReleaseWorktreeSuffix), nil
}

func (e *Env) fetch(ctx context.Context, root string) error {
	if _, err := e.git(ctx, root, "fetch", "--quiet", "--tags", "origin"); err != nil {
		return fmt.Errorf("could not fetch origin: %w", err)
	}
	return nil
}

func (e *Env) revParse(ctx context.Context, dir string, ref string) string {
	out, err := e.git(ctx, dir, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil {
		return ""
	}
	return out
}

func (e *Env) isAncestor(ctx context.Context, dir string, a string, b string) bool {
	_, err := e.git(ctx, dir, "merge-base", "--is-ancestor", a, b)
	return err == nil
}

// tagTaken tells where a tag already exists: locally or on origin. A collision found after the commit would leave a
// release commit with no tag (Notulia's release.sh).
func (e *Env) tagTaken(ctx context.Context, root string, tag string) string {
	if e.revParse(ctx, root, "refs/tags/"+tag) != "" {
		return "locally"
	}
	out, err := e.git(ctx, root, "ls-remote", "--tags", "--refs", "origin", "refs/tags/"+tag)
	if err == nil && strings.Contains(out, "refs/tags/"+tag) {
		return "on origin"
	}
	return ""
}

func (e *Env) tagOnOrigin(ctx context.Context, root string, tag string) (bool, error) {
	out, err := e.git(ctx, root, "ls-remote", "--tags", "--refs", "origin", "refs/tags/"+tag)
	if err != nil {
		return false, err
	}
	return strings.Contains(out, "refs/tags/"+tag), nil
}

// resetWorktree returns the release worktree to a clean state on start, creating it if needed: an interrupted
// cherry-pick, a prepared bump or a stray file left by a failed run must not make every retry fail the same way.
func (e *Env) resetWorktree(ctx context.Context, root string, wt string, start string) error {
	if _, err := os.Stat(filepath.Join(wt, ".git")); err != nil {
		if _, err := os.Stat(wt); err == nil {
			return fmt.Errorf("%s exists and is not a worktree of this repository: move it away", wt)
		}
		e.git(ctx, root, "worktree", "prune")
		if _, err := e.git(ctx, root, "worktree", "add", "--quiet", "--detach", wt, start); err != nil {
			return fmt.Errorf("could not create the release worktree %s: %w", wt, err)
		}
		return nil
	}
	ours, err := e.commonDir(ctx, root)
	if err != nil {
		return err
	}
	theirs, err := e.commonDir(ctx, wt)
	if err != nil || theirs != ours {
		return fmt.Errorf("%s is a worktree of another repository: move it away", wt)
	}
	e.git(ctx, wt, "cherry-pick", "--abort")
	e.git(ctx, wt, "merge", "--abort")
	if _, err := e.git(ctx, wt, "reset", "--quiet", "--hard"); err != nil {
		return err
	}
	if _, err := e.git(ctx, wt, "clean", "-qfd"); err != nil {
		return err
	}
	if _, err := e.git(ctx, wt, "checkout", "--quiet", "--detach", start); err != nil {
		return err
	}
	return nil
}

// releaseTags lists the project's release tags known locally.
func (e *Env) releaseTags(ctx context.Context, dir string, p *Project, args ...string) []string {
	lines, _ := e.gitLines(ctx, dir, append([]string{"tag", "--list"}, args...)...)
	tags := []string{}
	for _, tag := range lines {
		if _, ok := p.Rules.ReleaseOf(tag); ok {
			tags = append(tags, tag)
		}
	}
	return tags
}
