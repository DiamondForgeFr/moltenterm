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
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentchoice"
	"github.com/wavetermdev/waveterm/pkg/molten/spawns"
	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

const (
	DefaultTrunk         = molten.DefaultTrunkBranch
	DefaultReleaseBranch = molten.DefaultReleaseBranch
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

// https://host/owner/repo(.git), git@host:owner/repo(.git), ssh://git@host/owner/repo(.git), on a GitHub host.
var githubUrlRegex = regexp.MustCompile(`^(?:https://|ssh://git@|git@)([^/:]*github[^/:]*)[/:]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)/?$`)

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
	// Agent runs the coding agent CLI that writes the public notes, the prompt on its standard input; nil runs it with
	// ExecAgent. Tests replace it.
	Agent AgentRunner
	// CodingAgent asks MoltenTerm for the project's coding agent (#845) when the step's environment does not name it;
	// false when MoltenTerm cannot be reached (CI, a plain shell).
	CodingAgent func(ctx context.Context, dir string) (agentchoice.Choice, bool)
	Sleep       func(time.Duration)
	Now         func() time.Time
	// Zero means the defaults (30 s, 90 min).
	CiPoll  time.Duration
	CiLimit time.Duration
	// --ticket: the release's ticket, for a commit format that names one (#1046).
	Ticket int
}

// Project is what the release commands read from `.molten/project.json`.
type Project struct {
	Root    string
	Name    string
	Rules   versions.Rules
	Files   []versions.VersionFile
	Notes   string
	Trunk   string
	Release string
	// versions.notesagent: the coding agent CLI that writes the public notes, empty for none.
	NotesAgent []string
	// versions.changelogs: files the cut may commit beside the version files and the notes.
	Changelogs []string
	// Where the release branch's name was read (molten.BranchFrom…), for the messages that name it.
	ReleaseFrom string
	// The RC branch naming of the pull-request flow (#1046), e.g. rc-{version}; empty for DefaultRcBranchPattern.
	RcPattern string
	// How the chain's commits are worded (#1046).
	Convention Convention
	// ci.prepare: what installs the project's dependencies, run in the release worktree before its first commit when
	// the project has git hooks that need them (#1046).
	Install string
	// versions.format: the formatter the release's files go through before they are committed (#1095), empty to detect.
	Format string
}

// releaseBranchMissing says which branch was looked for, and why that one (#415).
func (p *Project) releaseBranchMissing() error {
	return fmt.Errorf("origin has no %s branch, the release branch (from %s): create it on origin, or name the project's release branch in %s (branches.release)", p.Release, p.ReleaseFrom, molten.ProjectPipelineFile)
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
	cmd := spawns.Command(ctx, name, args...)
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

// GithubRepo reads origin's GitHub repository from its URL ("[host/]owner/repo"), or "" when origin is not a GitHub
// URL it can read.
func GithubRepo(url string) string {
	m := githubUrlRegex.FindStringSubmatch(strings.TrimSpace(url))
	if m == nil {
		return ""
	}
	host, owner, repo := strings.ToLower(m[1]), m[2], strings.TrimSuffix(m[3], ".git")
	if host == "github.com" {
		return owner + "/" + repo
	}
	return host + "/" + owner + "/" + repo
}

// ghArgs names the repository in every gh call: gh resolves a remote named upstream before origin, so a fork that
// keeps its upstream as a remote would otherwise read, and start workflows in, the upstream's repository.
func ghArgs(repo string, args []string) []string {
	if repo == "" || len(args) == 0 {
		return args
	}
	if args[0] != "api" {
		return append(append([]string{}, args...), "--repo", repo)
	}
	parts := strings.Split(repo, "/")
	ownerRepo := strings.Join(parts[len(parts)-2:], "/")
	rtn := make([]string, 0, len(args)+2)
	for _, arg := range args {
		rtn = append(rtn, strings.ReplaceAll(arg, "{owner}/{repo}", ownerRepo))
	}
	if len(parts) == 3 {
		rtn = append(rtn, "--hostname", parts[0])
	}
	return rtn
}

func (e *Env) gh(ctx context.Context, dir string, args ...string) ([]byte, error) {
	url, _ := e.git(ctx, dir, "remote", "get-url", "origin")
	return e.run(ctx, dir, "gh", ghArgs(GithubRepo(url), args)...)
}

// OnGithub tells whether the project's origin is on GitHub.
func (e *Env) OnGithub(ctx context.Context, root string) bool {
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
	p := &Project{Root: root, Name: report.Pipeline.Name, Rules: versions.Rules{TagPrefix: versions.DefaultTagPrefix}, Notes: DefaultNotesPath}
	if v := report.Pipeline.Versions; v != nil {
		p.NotesAgent = v.NotesAgent
		p.Changelogs = v.Changelogs
		p.Format = strings.TrimSpace(v.Format)
		if v.TagPrefix != "" {
			p.Rules.TagPrefix = v.TagPrefix
		}
		p.Rules.FirstPublic = v.FirstPublic
		p.Rules.RcFormat = v.RcFormat
		if v.Notes != "" {
			p.Notes = v.Notes
		}
		p.Files = v.Files
	}
	branches := molten.ResolvedBranches(root)
	p.Trunk, p.Release, p.ReleaseFrom = branches.Trunk, branches.Release, branches.ReleaseFrom
	p.RcPattern = molten.RcBranchPattern(root)
	p.Convention = ReadConvention(root)
	if ci := report.Pipeline.Ci; ci != nil && ci.Prepare != nil {
		p.Install = strings.TrimSpace(ci.Prepare.Run)
	}
	return p, nil
}

// NotesFile is the notes path of a tag, relative to the project's root.
func (p *Project) NotesFile(tag string) string {
	return strings.ReplaceAll(p.Notes, "{tag}", tag)
}

// InternalNotesFile is where the engineering record of a tag sits: beside its public notes (releases/v1.2.0.internal.md
// beside releases/v1.2.0.md), as Mission Control reads it (pkg/molten/mission/git.go readNotes).
func (p *Project) InternalNotesFile(tag string) string {
	path := p.NotesFile(tag)
	ext := filepath.Ext(path)
	return strings.TrimSuffix(path, ext) + ".internal" + ext
}

// releaseOf reads a tag as one of the project's releases, refusing anything else: the tag goes into git commands and
// a commit message.
func (p *Project) releaseOf(tag string) (versions.Version, string, error) {
	v, ok := p.Rules.ReleaseOf(tag)
	if !ok || strings.TrimSpace(tag) != tag {
		prefix := p.Rules.TagPrefix
		return versions.Version{}, "", fmt.Errorf("%q is not a release tag of this project (%sX.Y.Z or %s%s)", tag, prefix, prefix, p.Rules.RcPattern())
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
	out, err := e.git(ctx, root, "ls-remote", "--tags", "--refs", "origin", "refs/tags/"+tag)
	if err == nil && strings.Contains(out, "refs/tags/"+tag) {
		return "on origin"
	}
	if e.revParse(ctx, root, "refs/tags/"+tag) != "" {
		return "locally only (left by an interrupted finalize? git tag -d " + tag + " removes it)"
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
