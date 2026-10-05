// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// The git side of a project, as Notulia's Dev › Timeline reads it (dev_git_timeline), with the branch names taken
// from the project instead of being fixed.

const trunkLogLimit = 300
const branchLogLimit = 150
const maxBranches = 60
const maxAhead = 400
const maxSincePublic = 500
const defaultTagPrefix = "v"
const defaultNotesPath = "releases/{tag}.md"

// Only the newest tags have their notes looked up in git when the checkout lacks the file: one git call each, and the
// overview shows the last ones.
const notesFromTagLimit = 6

type Commit struct {
	Sha     string `json:"sha"`
	Date    string `json:"date"`
	Subject string `json:"subject"`
}

type ForkPoint struct {
	Sha  string `json:"sha"`
	Date string `json:"date"`
}

type Branch struct {
	Name    string     `json:"name"`
	Sha     string     `json:"sha"`
	Date    string     `json:"date"`
	Commits []Commit   `json:"commits"`
	Fork    *ForkPoint `json:"fork"`
}

type Tag struct {
	Name          string `json:"name"`
	Sha           string `json:"sha"`
	Date          string `json:"date"`
	Notes         string `json:"notes,omitempty"`
	NotesInternal string `json:"notesinternal,omitempty"`
}

type GitSnapshot struct {
	Trunk       string   `json:"trunk"`
	Release     string   `json:"release"`
	Current     string   `json:"current,omitempty"`
	RemoteUrl   string   `json:"remoteurl,omitempty"`
	Branches    []Branch `json:"branches"`
	Tags        []Tag    `json:"tags"`
	Ahead       []Commit `json:"ahead"`
	LastPublic  string   `json:"lastpublic,omitempty"`
	SincePublic []Commit `json:"sincepublic"`
	FetchError  string   `json:"fetcherror,omitempty"`
	// The project's release tags start with it (versions.tagprefix).
	TagPrefix string `json:"tagprefix"`
	// versions.firstpublic: tags below its first candidate are not the project's releases.
	FirstPublic string `json:"firstpublic,omitempty"`
}

// ProjectBranches are the two long-lived branches: work is merged into the trunk, releases are cut from the release
// branch. The same branch for both is a single-branch project.
type ProjectBranches struct {
	Trunk   string `json:"trunk"`
	Release string `json:"release"`
}

func readJson(path string, target any) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return json.Unmarshal(data, target) == nil
}

// ConfiguredBranches reads the branch names the project declares: `.molten/project.json` first, then
// `.saasfoundry.json`. Empty names are left to the repository's defaults.
func ConfiguredBranches(dir string) ProjectBranches {
	var rtn ProjectBranches
	var pipeline struct {
		Branches ProjectBranches `json:"branches"`
	}
	if readJson(filepath.Join(dir, ".molten", "project.json"), &pipeline) {
		rtn = pipeline.Branches
	}
	var sf struct {
		MainBranch string `json:"mainBranch"`
		Workflow   struct {
			WorkingBranch string `json:"workingBranch"`
		} `json:"workflow"`
	}
	if readJson(filepath.Join(dir, ".saasfoundry.json"), &sf) {
		if rtn.Trunk == "" {
			rtn.Trunk = sf.Workflow.WorkingBranch
		}
		if rtn.Release == "" {
			rtn.Release = sf.MainBranch
		}
	}
	return rtn
}

type gitReader struct {
	ctx context.Context
	run Runner
	dir string
	// versions.tagprefix and versions.notes, or their defaults.
	tagPrefix string
	notes     string
	rules     versions.Rules
}

// ConfiguredVersions reads versions.tagprefix and versions.notes from the pipeline, or their defaults.
func ConfiguredVersions(dir string) (string, string) {
	var pipeline struct {
		Versions struct {
			TagPrefix string `json:"tagprefix"`
			Notes     string `json:"notes"`
		} `json:"versions"`
	}
	readJson(filepath.Join(dir, ".molten", "project.json"), &pipeline)
	prefix, notes := pipeline.Versions.TagPrefix, pipeline.Versions.Notes
	if prefix == "" {
		prefix = defaultTagPrefix
	}
	if notes == "" || !strings.Contains(notes, "{tag}") {
		notes = defaultNotesPath
	}
	return prefix, notes
}

// ConfiguredRules reads the project's numbering rules (versions.tagprefix, versions.firstpublic).
func ConfiguredRules(dir string) versions.Rules {
	var pipeline struct {
		Versions versions.Rules `json:"versions"`
	}
	readJson(filepath.Join(dir, ".molten", "project.json"), &pipeline)
	rules := pipeline.Versions
	if rules.TagPrefix == "" {
		rules.TagPrefix = defaultTagPrefix
	}
	return rules
}

func (g *gitReader) out(args ...string) (string, error) {
	out, err := g.run(g.ctx, g.dir, "git", args...)
	return strings.TrimRight(string(out), "\n"), err
}

func (g *gitReader) lines(args ...string) []string {
	out, err := g.out(args...)
	if err != nil || out == "" {
		return nil
	}
	return strings.Split(out, "\n")
}

func (g *gitReader) refExists(ref string) bool {
	_, err := g.out("rev-parse", "--verify", "--quiet", ref+"^{commit}")
	return err == nil
}

// The remote branch when there is one: the panels show what is shared, local work shows as branches.
func (g *gitReader) refOf(name string) string {
	if name == "" {
		return ""
	}
	if g.refExists("origin/" + name) {
		return "origin/" + name
	}
	if g.refExists(name) {
		return name
	}
	return ""
}

func (g *gitReader) firstExisting(names ...string) string {
	for _, name := range names {
		if g.refOf(name) != "" {
			return name
		}
	}
	return ""
}

func parseCommits(lines []string) []Commit {
	commits := []Commit{}
	for _, line := range lines {
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		commits = append(commits, Commit{Sha: parts[0], Date: parts[1], Subject: parts[2]})
	}
	return commits
}

const commitFormat = "--format=%H%x09%cI%x09%s"

func (g *gitReader) commitDate(ref string) string {
	out, _ := g.out("show", "-s", "--format=%cI", ref)
	return out
}

func (g *gitReader) trunkBranch(name string, ref string) Branch {
	sha, _ := g.out("rev-parse", ref)
	return Branch{
		Name:    name,
		Sha:     sha,
		Date:    g.commitDate(ref),
		Commits: parseCommits(g.lines("log", "--first-parent", commitFormat, "-n", strconv.Itoa(trunkLogLimit), ref)),
	}
}

var tagNotesSafe = regexp.MustCompile(`^[A-Za-z0-9._+-]+$`)

// readNotes reads a tag's notes where the project keeps them; internal reads the internal notes beside them
// (releases/v1.2.0.internal.md beside releases/v1.2.0.md). fromTag also looks in the tag's own tree when the checkout
// does not hold the file: a cut prepared and tagged in a release worktree reaches the trunk only once carried back.
func (g *gitReader) readNotes(tag string, internal bool, fromTag bool) string {
	if !tagNotesSafe.MatchString(tag) {
		return ""
	}
	path := strings.ReplaceAll(g.notes, "{tag}", tag)
	if internal {
		ext := filepath.Ext(path)
		path = strings.TrimSuffix(path, ext) + ".internal" + ext
	}
	full := filepath.Join(g.dir, path)
	if !strings.HasPrefix(full, filepath.Clean(g.dir)+string(filepath.Separator)) {
		return ""
	}
	data, err := os.ReadFile(full)
	if err == nil {
		return string(data)
	}
	if !fromTag {
		return ""
	}
	rel, err := filepath.Rel(g.dir, full)
	if err != nil {
		return ""
	}
	out, err := g.run(g.ctx, g.dir, "git", "show", "refs/tags/"+tag+":"+filepath.ToSlash(rel))
	if err != nil {
		return ""
	}
	return string(out)
}

func (g *gitReader) tags() []Tag {
	tags := []Tag{}
	for _, line := range g.lines("for-each-ref", "--sort=-creatordate", "--format=%(refname:short)%09%(objectname)%09%(*objectname)%09%(creatordate:iso-strict)", "refs/tags/"+g.tagPrefix+"*") {
		parts := strings.Split(line, "\t")
		if len(parts) < 4 {
			continue
		}
		sha := parts[1]
		if parts[2] != "" {
			sha = parts[2]
		}
		fromTag := len(tags) < notesFromTagLimit
		tags = append(tags, Tag{
			Name:          parts[0],
			Sha:           sha,
			Date:          parts[3],
			Notes:         g.readNotes(parts[0], false, fromTag),
			NotesInternal: g.readNotes(parts[0], true, fromTag),
		})
	}
	return tags
}

// IsPrereleaseTag is Notulia's rule: a release candidate is a version with a suffix (v1.2.0-3), read after the
// project's tag prefix (which may itself hold a dash, as release-1.2.0).
func IsPrereleaseTag(name string, prefix string) bool {
	return strings.Contains(strings.TrimPrefix(name, prefix), "-")
}

// The highest public release in semver order; tags outside the strict X.Y.Z form, or below versions.firstpublic (a
// fork's upstream tags), are not releases.
func (g *gitReader) lastPublic() string {
	return g.rules.LastPublic(g.lines("tag", "-l", g.tagPrefix+"*"))
}

// The commits on the trunk that the release branch does not have yet. `git cherry` compares content: a project that
// rebases its releases holds copies of the trunk's commits.
func (g *gitReader) ahead(releaseRef string, baseRef string) []Commit {
	if releaseRef == "" || releaseRef == baseRef {
		return []Commit{}
	}
	var shas []string
	for _, line := range g.lines("cherry", releaseRef, baseRef) {
		if sha, ok := strings.CutPrefix(line, "+ "); ok {
			shas = append(shas, sha)
		}
		if len(shas) >= maxAhead {
			break
		}
	}
	if len(shas) == 0 {
		return []Commit{}
	}
	return parseCommits(g.lines(append([]string{"log", "--no-walk=unsorted", commitFormat}, shas...)...))
}

func (g *gitReader) featureBranches(baseRef string, skip map[string]bool) []Branch {
	branches := []Branch{}
	for _, line := range g.lines("for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)", "refs/heads") {
		parts := strings.Split(line, "\t")
		if len(parts) < 3 || skip[parts[0]] {
			continue
		}
		if len(branches) >= maxBranches {
			break
		}
		branch := Branch{Name: parts[0], Sha: parts[1], Date: parts[2], Commits: []Commit{}}
		if baseRef != "" {
			if fork, err := g.out("merge-base", baseRef, parts[0]); err == nil && fork != "" {
				branch.Fork = &ForkPoint{Sha: fork, Date: g.commitDate(fork)}
			}
			branch.Commits = parseCommits(g.lines("log", commitFormat, "-n", strconv.Itoa(branchLogLimit), baseRef+".."+parts[0]))
		}
		branches = append(branches, branch)
	}
	return branches
}

// GitHubWebUrl turns an origin URL into the repository's web address, for links; empty when it is not GitHub.
func GitHubWebUrl(remote string) string {
	remote = strings.TrimSpace(remote)
	remote = strings.TrimSuffix(remote, ".git")
	switch {
	case strings.HasPrefix(remote, "git@github.com:"):
		return "https://github.com/" + strings.TrimPrefix(remote, "git@github.com:")
	case strings.HasPrefix(remote, "ssh://git@github.com/"):
		return "https://github.com/" + strings.TrimPrefix(remote, "ssh://git@github.com/")
	case strings.HasPrefix(remote, "https://github.com/"):
		return remote
	}
	return ""
}

// CollectGit reads the project's history. fetch updates the remote branches and tags first; a failed fetch (offline,
// no remote) is reported and the local state is still read.
func CollectGit(ctx context.Context, run Runner, dir string, fetch bool) (*GitSnapshot, error) {
	g := &gitReader{ctx: ctx, run: run, dir: dir}
	g.tagPrefix, g.notes = ConfiguredVersions(dir)
	g.rules = ConfiguredRules(dir)
	if _, err := g.out("rev-parse", "--git-dir"); err != nil {
		return nil, err
	}
	snap := &GitSnapshot{Branches: []Branch{}, Tags: []Tag{}, Ahead: []Commit{}, SincePublic: []Commit{}, TagPrefix: g.tagPrefix, FirstPublic: g.rules.FirstPublic}
	remote, _ := g.out("remote", "get-url", "origin")
	snap.RemoteUrl = GitHubWebUrl(remote)
	if fetch && remote != "" {
		if _, err := g.out("fetch", "--quiet", "--tags", "--prune", "origin"); err != nil {
			snap.FetchError = err.Error()
		}
	}
	configured := ConfiguredBranches(dir)
	snap.Trunk = configured.Trunk
	if g.refOf(snap.Trunk) == "" {
		snap.Trunk = g.firstExisting("develop", "main", "master")
	}
	snap.Release = configured.Release
	if g.refOf(snap.Release) == "" {
		snap.Release = g.firstExisting("main", "master")
	}
	if snap.Release == "" {
		snap.Release = snap.Trunk
	}
	snap.Current, _ = g.out("symbolic-ref", "--short", "-q", "HEAD")
	baseRef := g.refOf(snap.Trunk)
	releaseRef := g.refOf(snap.Release)
	skip := map[string]bool{}
	for _, name := range []string{snap.Release, snap.Trunk} {
		if name == "" || skip[name] {
			continue
		}
		skip[name] = true
		if ref := g.refOf(name); ref != "" {
			snap.Branches = append(snap.Branches, g.trunkBranch(name, ref))
		}
	}
	snap.Branches = append(snap.Branches, g.featureBranches(baseRef, skip)...)
	snap.Tags = g.tags()
	snap.Ahead = g.ahead(releaseRef, baseRef)
	snap.LastPublic = g.lastPublic()
	if snap.LastPublic != "" && baseRef != "" {
		snap.SincePublic = parseCommits(g.lines("log", "--no-merges", commitFormat, "-n", strconv.Itoa(maxSincePublic), snap.LastPublic+".."+baseRef))
	}
	return snap, nil
}
