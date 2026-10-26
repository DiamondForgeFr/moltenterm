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
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// The git side of a project, as Notulia's Dev › Timeline reads it (dev_git_timeline), with the branch names taken
// from the project instead of being fixed.

const trunkLogLimit = 300
const branchLogLimit = 150
const maxBranches = 60

// The branches an agent tool names after its worktree (Claude Code's Agent tool: worktree-agent-<id>).
const agentTreePrefix = "worktree-agent-"
const maxAhead = 400
const maxSincePublic = 500
const defaultTagPrefix = "v"
const defaultNotesPath = "releases/{tag}.md"

// Only the newest tags have their notes looked up in git when the checkout lacks the file: one git call each, and the
// overview shows the last ones.
const notesFromTagLimit = 6

// The line map (FR-MC-022) reads the trunk's merges: at most this many, each walked back over at most this many of the
// merged branch's own commits, inside one read of the trunk's history this long.
const maxMerges = 60
const maxMergeCommits = 150
const mergeLogLimit = 4000

type Commit struct {
	Sha     string `json:"sha"`
	Date    string `json:"date"`
	Subject string `json:"subject"`
	// Only on the long-lived branches' commits: the line map finds merges (several parents) and the copies a rebased
	// or cherry-picked release branch holds (same subject and author date) from them.
	Parents    []string `json:"parents,omitempty"`
	AuthorDate string   `json:"authordate,omitempty"`
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
	// AgentTree: a branch an agent tool made for its worktree (worktree-agent-…), kept because it holds commits of its
	// own (#1123).
	AgentTree bool `json:"agenttree,omitempty"`
	// The linked worktree that has the branch checked out, the main checkout aside (#1133): shown on hover only, the
	// row names the branch.
	Worktree string `json:"worktree,omitempty"`
}

// Merge is a branch merged into the trunk by a merge commit, read back from the commit's second parent: where the
// branch left the trunk, how many commits of its own it brought and when the first of them was written. A project
// that rebases or squashes has none; the line map infers its branches from the trunk's commits instead.
type Merge struct {
	Sha     string     `json:"sha"`
	Date    string     `json:"date"`
	Subject string     `json:"subject"`
	Fork    *ForkPoint `json:"fork"`
	Commits int        `json:"commits"`
	// The earliest author date among the branch's own commits; empty when none could be read.
	FirstDate string `json:"firstdate,omitempty"`
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
	Merges      []Merge  `json:"merges"`
	Ahead       []Commit `json:"ahead"`
	LastPublic  string   `json:"lastpublic,omitempty"`
	SincePublic []Commit `json:"sincepublic"`
	FetchError  string   `json:"fetcherror,omitempty"`
	// The project's release tags start with it (versions.tagprefix).
	TagPrefix string `json:"tagprefix"`
	// versions.firstpublic: tags below its first candidate are not the project's releases.
	FirstPublic string `json:"firstpublic,omitempty"`
	// versions.rcformat: how the next release candidates are numbered (#1155).
	RcFormat string `json:"rcformat,omitempty"`
}

// ProjectBranches are the two long-lived branches (molten.ProjectBranches).
type ProjectBranches = molten.ProjectBranches

func readJson(path string, target any) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return json.Unmarshal(data, target) == nil
}

// ConfiguredBranches reads the branch names the project declares (molten.ConfiguredBranches).
func ConfiguredBranches(dir string) ProjectBranches {
	return molten.ConfiguredBranches(dir)
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

// ConfiguredRules reads the project's numbering rules (versions.tagprefix, versions.firstpublic, versions.rcformat).
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

const historyFormat = "--format=%H%x09%cI%x09%aI%x09%P%x09%s"

// parseHistory reads commits logged with historyFormat: with their parents and author date.
func parseHistory(lines []string) []Commit {
	commits := []Commit{}
	for _, line := range lines {
		parts := strings.SplitN(line, "\t", 5)
		if len(parts) < 5 {
			continue
		}
		commits = append(commits, Commit{
			Sha:        parts[0],
			Date:       parts[1],
			AuthorDate: parts[2],
			Parents:    strings.Fields(parts[3]),
			Subject:    parts[4],
		})
	}
	return commits
}

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
		Commits: parseHistory(g.lines("log", "--first-parent", historyFormat, "-n", strconv.Itoa(trunkLogLimit), ref)),
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

// longLived are the branches whose commits are no branch's own work (#1133): the trunk, the release branch and the
// rc branches, local and on origin. A worktree started on the release branch's tip holds commits the trunk lacks.
type longLived struct {
	refs     []string
	rcPrefix string
}

func (g *gitReader) longLivedOf(names []string, rcPattern string) longLived {
	rtn := longLived{}
	seen := map[string]bool{}
	for _, name := range names {
		for _, ref := range []string{"refs/heads/" + name, "refs/remotes/origin/" + name} {
			if name == "" || seen[ref] || !g.refExists(ref) {
				continue
			}
			seen[ref] = true
			rtn.refs = append(rtn.refs, ref)
		}
	}
	if prefix, _, ok := strings.Cut(rcPattern, "{"); ok && prefix != "" && !strings.ContainsAny(prefix, "*?[\\") {
		rtn.rcPrefix = prefix
	}
	return rtn
}

// notArgs exclude the long-lived branches' commits from a branch's log; an rc branch is not measured against itself.
func (l longLived) notArgs(self string) []string {
	args := append([]string{"--not"}, l.refs...)
	if l.rcPrefix == "" {
		return args
	}
	for _, space := range []string{"refs/heads/", "refs/remotes/origin/"} {
		args = append(args, "--exclude=refs/heads/"+self, "--exclude=refs/remotes/origin/"+self, "--glob="+space+l.rcPrefix+"*")
	}
	return args
}

// worktrees maps each branch checked out in a linked worktree to the worktree's folder; the main checkout, listed
// first, is the project itself.
func (g *gitReader) worktrees() map[string]string {
	rtn := map[string]string{}
	path := ""
	first := true
	for _, line := range g.lines("worktree", "list", "--porcelain") {
		if p, ok := strings.CutPrefix(line, "worktree "); ok {
			if path != "" {
				first = false
			}
			path = p
			continue
		}
		if ref, ok := strings.CutPrefix(line, "branch refs/heads/"); ok && !first && path != "" {
			rtn[ref] = path
		}
	}
	return rtn
}

func (g *gitReader) featureBranches(baseRef string, skip map[string]bool, long longLived) []Branch {
	branches := []Branch{}
	trees := g.worktrees()
	for _, line := range g.lines("for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)", "refs/heads") {
		parts := strings.Split(line, "\t")
		if len(parts) < 3 || skip[parts[0]] {
			continue
		}
		if len(branches) >= maxBranches {
			break
		}
		name := parts[0]
		agentTree := strings.HasPrefix(name, agentTreePrefix)
		worktree := trees[name]
		if agentTree && worktree == "" && !g.hasOwnCommits(name) {
			continue
		}
		branch := Branch{Name: name, Sha: parts[1], Date: parts[2], Commits: []Commit{}, AgentTree: agentTree, Worktree: worktree}
		if baseRef != "" {
			if fork, err := g.out("merge-base", baseRef, name); err == nil && fork != "" {
				branch.Fork = &ForkPoint{Sha: fork, Date: g.commitDate(fork)}
			}
		}
		if len(long.refs) > 0 {
			args := append([]string{"log", commitFormat, "-n", strconv.Itoa(branchLogLimit), "refs/heads/" + name}, long.notArgs(name)...)
			branch.Commits = parseCommits(g.lines(args...))
		}
		if agentTree && len(branch.Commits) == 0 {
			continue
		}
		branches = append(branches, branch)
	}
	return branches
}

// hasOwnCommits: the agent tool's branch holds a commit no other branch, remote branch or tag holds (#1123). Its
// worktree starts on the checkout's commit, often the release branch's, which reads as commits ahead of the trunk;
// other agents' branches do not count, so two that started on the same commit are both left out.
func (g *gitReader) hasOwnCommits(name string) bool {
	count, err := g.out("rev-list", "--count", "refs/heads/"+name, "--not", "--exclude="+agentTreePrefix+"*", "--branches",
		"--remotes", "--tags")
	if err != nil {
		return true
	}
	n, err := strconv.Atoi(strings.TrimSpace(count))
	return err != nil || n > 0
}

func earlierDate(a string, b string) bool {
	ta, errA := time.Parse(time.RFC3339, a)
	tb, errB := time.Parse(time.RFC3339, b)
	if errA != nil || errB != nil {
		return false
	}
	return ta.Before(tb)
}

type historyNode struct {
	parents    []string
	authorDate string
}

// merges reads the branches the trunk's merge commits brought in. One bounded read of the trunk's whole history, only
// when its first-parent history holds a merge: each merge's second parent is walked back, along first parents, to the
// trunk. A merge whose branch runs past what was read keeps no fork point.
func (g *gitReader) merges(baseRef string, trunk []Commit) []Merge {
	rtn := []Merge{}
	onTrunk := map[string]string{}
	var candidates []Commit
	for _, c := range trunk {
		onTrunk[c.Sha] = c.Date
		if len(c.Parents) > 1 && len(candidates) < maxMerges {
			candidates = append(candidates, c)
		}
	}
	if baseRef == "" || len(candidates) == 0 {
		return rtn
	}
	graph := map[string]historyNode{}
	for _, line := range g.lines("log", "--format=%H%x09%aI%x09%P", "-n", strconv.Itoa(mergeLogLimit), "--end-of-options", baseRef) {
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		graph[parts[0]] = historyNode{parents: strings.Fields(parts[2]), authorDate: parts[1]}
	}
	for _, c := range candidates {
		merge := Merge{Sha: c.Sha, Date: c.Date, Subject: c.Subject}
		sha := c.Parents[1]
		for steps := 0; steps <= maxMergeCommits; steps++ {
			if date, ok := onTrunk[sha]; ok {
				merge.Fork = &ForkPoint{Sha: sha, Date: date}
				break
			}
			node, ok := graph[sha]
			if !ok || steps == maxMergeCommits {
				break
			}
			merge.Commits++
			if merge.FirstDate == "" || earlierDate(node.authorDate, merge.FirstDate) {
				merge.FirstDate = node.authorDate
			}
			if len(node.parents) == 0 {
				break
			}
			sha = node.parents[0]
		}
		rtn = append(rtn, merge)
	}
	return rtn
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
	snap := &GitSnapshot{Branches: []Branch{}, Tags: []Tag{}, Merges: []Merge{}, Ahead: []Commit{}, SincePublic: []Commit{}, TagPrefix: g.tagPrefix, FirstPublic: g.rules.FirstPublic, RcFormat: g.rules.RcFormat}
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
	for _, b := range snap.Branches {
		if b.Name == snap.Trunk {
			snap.Merges = g.merges(baseRef, b.Commits)
		}
	}
	long := g.longLivedOf([]string{snap.Trunk, snap.Release}, molten.RcBranchPattern(dir))
	snap.Branches = append(snap.Branches, g.featureBranches(baseRef, skip, long)...)
	snap.Tags = g.tags()
	snap.Ahead = g.ahead(releaseRef, baseRef)
	snap.LastPublic = g.lastPublic()
	if snap.LastPublic != "" && baseRef != "" {
		snap.SincePublic = parseCommits(g.lines("log", "--no-merges", commitFormat, "-n", strconv.Itoa(maxSincePublic), snap.LastPublic+".."+baseRef))
	} else if baseRef != "" {
		// Before the first public release, everything on the trunk waits for it: the counts stay honest without a
		// remote or a tag (#745).
		snap.SincePublic = parseCommits(g.lines("log", "--no-merges", commitFormat, "-n", strconv.Itoa(maxSincePublic), baseRef))
	}
	return snap, nil
}
