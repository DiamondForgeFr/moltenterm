// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Cross-repo dependencies (FR-MC-029, DS-MC-019): a member declares in `dependson` the files it reads from another
// member of its group. When it last synced is read from git, never from a stamp file: its newest commit touching
// `output` on its trunk, against the source's newest commit touching `paths` on the watched branch. Only the local git
// is read (the remote-tracking branches are as fresh as the collector's own fetch, NFR-MC-008), with no optional lock,
// so nothing is written in either repository, not even an index refresh (NFR-MC-006).

// must match frontend/moltenterm-shell/mission/group-model.ts and cmd/wsh/cmd/wshcmd-molten-projectdeps.go
const (
	DepsCommand            = "moltenmissiondeps"
	DepStateInSync         = "insync"
	DepStateStale          = "stale"
	DepStateUncommitted    = "uncommitted"
	DepStateSourceNotFound = "sourcenotfound"
	DepStateBranchNotFound = "branchnotfound"
	DepStateInvalid        = "invalid"
	DepStateError          = "error"
	// The commits since the last sync that are listed; the count says when there are more.
	maxDepCommits      = 20
	maxDepChangedPaths = 50
	maxDepUncommitted  = 50
	// Each dependency on its own: a slow one does not use up the others' time.
	depEvaluateTimeout = 5 * time.Second
	depCommitFormat    = "--format=%H%x09%ct%x09%s"
	// A commit subject never holds a NUL, so it cannot forge a record.
	depRecordSeparator = "\x00"
)

var depTicketRegex = regexp.MustCompile(`#(\d+)\b`)
var depShaRegex = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

type DependencyCommit struct {
	Sha     string `json:"sha"`
	Time    int64  `json:"time"`
	Subject string `json:"subject"`
	// The ticket numbers the subject names (`feat(#1151): ...`, `... (#1151)`).
	Tickets []string `json:"tickets,omitempty"`
}

// DependencyState is one declared dependency, evaluated.
type DependencyState struct {
	Index   int      `json:"index"`
	Project string   `json:"project"`
	Paths   []string `json:"paths"`
	Output  []string `json:"output"`
	Sync    string   `json:"sync,omitempty"`
	// The watched branch: the declared one, else the source's trunk; and the ref read for it.
	Branch string `json:"branch,omitempty"`
	Ref    string `json:"ref,omitempty"`
	State  string `json:"state"`
	// Why the dependency is not evaluated (invalid, source or branch not found, a git error).
	Problem    string `json:"problem,omitempty"`
	SourceDir  string `json:"sourcedir,omitempty"`
	SourceName string `json:"sourcename,omitempty"`
	// The source's newest commit on the watched branch touching paths, as it landed there (a merge with its own time).
	Source *DependencyCommit `json:"source,omitempty"`
	// The dependent's newest commit touching output on its trunk, local or on origin: its last sync. None when it never
	// synced.
	Synced *DependencyCommit `json:"synced,omitempty"`
	Trunk  string            `json:"trunk,omitempty"`
	// While stale: the source commits since the last sync touching paths, newest first, and the paths they changed.
	Commits     []DependencyCommit `json:"commits,omitempty"`
	MoreCommits bool               `json:"morecommits,omitempty"`
	Changed     []string           `json:"changed,omitempty"`
	// While stale: the output files changed and not committed in the dependent ("synced, not committed").
	Uncommitted []string `json:"uncommitted,omitempty"`
	// In sync because a sync of the source's current commit changed nothing (FR-MC-030-AC4): when it was recorded.
	Acknowledged int64 `json:"acknowledged,omitempty"`
	// The last sync of this declaration, from the dependent's run history; running while it runs.
	LastSync  *DependencySyncRun `json:"lastsync,omitempty"`
	CheckedAt int64              `json:"checkedat,omitempty"`
	// The commits the evaluation read (the source's watched ref, the dependent's trunks): while none moves, the history
	// is not read again.
	inputs string
	// The full ref read for the watched branch (refs/remotes/origin/… or refs/heads/…): a sync checks out its tip.
	sourceRef string
}

// Flagged tells a dependency that holds its member's amber flag: stale, or synced and not committed yet.
func (s DependencyState) Flagged() bool {
	return s.State == DepStateStale || s.State == DepStateUncommitted
}

// ReadDependsOn reads a project's name and declarations leniently, like its group: a mistake elsewhere in the file does
// not hide a stale dependency.
func ReadDependsOn(dir string) (string, []molten.PipelineDependency) {
	var pipeline struct {
		Name      string                      `json:"name"`
		DependsOn []molten.PipelineDependency `json:"dependson"`
	}
	if !readJson(filepath.Join(dir, molten.ProjectPipelineFile), &pipeline) {
		return "", nil
	}
	return pipeline.Name, pipeline.DependsOn
}

// CommitTickets reads the ticket numbers a commit subject names, in order, once each.
func CommitTickets(subject string) []string {
	var tickets []string
	seen := map[string]bool{}
	for _, m := range depTicketRegex.FindAllStringSubmatch(subject, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			tickets = append(tickets, m[1])
		}
	}
	return tickets
}

func depPathspecs(globs []string) []string {
	specs := make([]string, 0, len(globs))
	for _, glob := range globs {
		specs = append(specs, ":(glob)"+strings.TrimSpace(glob))
	}
	return specs
}

// safeRef keeps a branch name read from a project's files from being taken as an option by git.
func safeRef(ref string) bool {
	return ref != "" && !strings.HasPrefix(ref, "-")
}

// depRefs are the branches of a repository that exist, with the commit each points at, read in one git call: each
// git call costs a process, and the check has 200 ms per dependency (NFR-MC-008).
type depRefs map[string]string

func (g *gitReader) readDepRefs(names ...string) (depRefs, error) {
	args := []string{"for-each-ref", "--format=%(refname)%09%(objectname)"}
	for _, name := range names {
		if safeRef(name) {
			args = append(args, "refs/heads/"+name, "refs/remotes/origin/"+name)
		}
	}
	refs := depRefs{}
	if len(args) == 2 {
		return refs, nil
	}
	out, err := g.out(args...)
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(out, "\n") {
		if ref, sha, ok := strings.Cut(strings.TrimSpace(line), "\t"); ok && ref != "" {
			refs[ref] = sha
		}
	}
	return refs, nil
}

func (r depRefs) local(name string) string {
	if safeRef(name) && r["refs/heads/"+name] != "" {
		return "refs/heads/" + name
	}
	return ""
}

func (r depRefs) remote(name string) string {
	if safeRef(name) && r["refs/remotes/origin/"+name] != "" {
		return "refs/remotes/origin/" + name
	}
	return ""
}

// watched is the ref read for a branch, as the collector reads it: origin's when it exists, else the local one.
func (r depRefs) watched(name string) string {
	if ref := r.remote(name); ref != "" {
		return ref
	}
	return r.local(name)
}

// trunkCandidates are the names the trunk may have: the declared one, else develop, main or master.
func trunkCandidates(dir string) []string {
	return []string{ConfiguredBranches(dir).Trunk, "develop", "main", "master"}
}

// trunk is the first candidate that exists, local or on origin.
func (r depRefs) trunk(candidates []string) string {
	for _, name := range candidates {
		if r.watched(name) != "" {
			return name
		}
	}
	return ""
}

func shortRef(ref string) string {
	ref = strings.TrimPrefix(ref, "refs/heads/")
	return strings.TrimPrefix(ref, "refs/remotes/")
}

func parseDepCommit(line string) (DependencyCommit, bool) {
	parts := strings.SplitN(strings.TrimSpace(line), "\t", 3)
	if len(parts) < 3 {
		return DependencyCommit{}, false
	}
	seconds, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return DependencyCommit{}, false
	}
	if !depShaRegex.MatchString(parts[0]) {
		return DependencyCommit{}, false
	}
	return DependencyCommit{Sha: parts[0], Time: seconds * 1000, Subject: parts[2], Tickets: CommitTickets(parts[2])}, true
}

// newestTouching is the newest commit of ref touching the pathspecs; nil when none does. firstParent reads the commits
// as they landed on ref: a merge counts with its own time, so a change made on a feature branch before the dependent's
// sync and merged after it is still newer than the sync.
func (g *gitReader) newestTouching(ref string, specs []string, firstParent bool) (*DependencyCommit, error) {
	args := []string{"log", "-1", depCommitFormat}
	if firstParent {
		args = append(args, "--first-parent")
	}
	args = append(append(args, ref, "--"), specs...)
	out, err := g.out(args...)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(out) == "" {
		return nil, nil
	}
	commit, ok := parseDepCommit(out)
	if !ok {
		return nil, fmt.Errorf("unreadable git log line %q", out)
	}
	return &commit, nil
}

// landedBefore is the newest commit of ref's first-parent line made at or before a time: what ref held then.
func (g *gitReader) landedBefore(ref string, at int64) (string, error) {
	out, err := g.out("rev-list", "-1", "--first-parent", fmt.Sprintf("--before=@%d", at/1000), ref)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// commitsSince lists the commits that landed on ref after a time (all of them when it is 0) touching the pathspecs,
// newest first, merges aside, with the paths each changed. The range starts from what ref held at that time, not from
// the commits' own dates: a feature commit older than the sync and merged after it is listed.
func (g *gitReader) commitsSince(ref string, specs []string, after int64) ([]DependencyCommit, bool, []string, error) {
	args := []string{"-c", "core.quotePath=false", "log", "-n", strconv.Itoa(maxDepCommits + 1), "--no-merges", "--name-only",
		"--format=%x00%H%x09%ct%x09%s", ref}
	if after > 0 {
		base, err := g.landedBefore(ref, after)
		if err != nil {
			return nil, false, nil, err
		}
		if base != "" {
			args = append(args, "^"+base)
		}
	}
	args = append(append(args, "--"), specs...)
	out, err := g.out(args...)
	if err != nil {
		return nil, false, nil, err
	}
	commits := []DependencyCommit{}
	more := false
	changed := map[string]bool{}
	for _, record := range strings.Split(out, depRecordSeparator) {
		lines := strings.Split(strings.TrimSpace(record), "\n")
		commit, ok := parseDepCommit(lines[0])
		if !ok {
			continue
		}
		if len(commits) == maxDepCommits {
			more = true
			break
		}
		commits = append(commits, commit)
		for _, name := range lines[1:] {
			if name = strings.TrimSpace(name); name != "" {
				changed[name] = true
			}
		}
	}
	paths := make([]string, 0, len(changed))
	for name := range changed {
		paths = append(paths, name)
	}
	sort.Strings(paths)
	if len(paths) > maxDepChangedPaths {
		paths = paths[:maxDepChangedPaths]
	}
	return commits, more, paths, nil
}

// uncommitted lists the files matching the pathspecs that differ from HEAD or are untracked. --no-optional-locks: a
// status never refreshes the dependent's index (NFR-MC-006).
func (g *gitReader) uncommitted(specs []string) ([]string, error) {
	args := append([]string{"--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=all", "--"}, specs...)
	out, err := g.run(g.ctx, g.dir, "git", args...)
	if err != nil {
		return nil, err
	}
	files := []string{}
	entries := strings.Split(string(out), "\x00")
	for i := 0; i < len(entries); i++ {
		entry := entries[i]
		if len(entry) < 4 {
			continue
		}
		files = append(files, entry[3:])
		// A rename or copy, in the index or in the worktree, is followed by its original path.
		if strings.ContainsAny(entry[:2], "RC") {
			i++
		}
		if len(files) == maxDepUncommitted {
			break
		}
	}
	return files, nil
}

// dependentTrunk is the dependent's trunk and its refs, local and on origin.
func (g *gitReader) dependentTrunk() (string, []string, error) {
	candidates := trunkCandidates(g.dir)
	refs, err := g.readDepRefs(candidates...)
	if err != nil {
		return "", nil, err
	}
	trunk := refs.trunk(candidates)
	if trunk == "" {
		return "", nil, fmt.Errorf("the project has no trunk branch (develop, main or master, or branches.trunk)")
	}
	var trunkRefs []string
	seen := map[string]bool{}
	for _, ref := range []string{refs.local(trunk), refs.remote(trunk)} {
		// The local trunk and origin's often point at the same commit: its history is read once.
		if ref == "" || seen[refs[ref]] {
			continue
		}
		seen[refs[ref]] = true
		trunkRefs = append(trunkRefs, ref+"\t"+refs[ref])
	}
	return trunk, trunkRefs, nil
}

// lastSync is the dependent's newest commit touching output on its trunk refs, local or remote: the newest wins, so a
// sync committed and not pushed yet counts, and so does one pushed from another checkout and fetched.
func (g *gitReader) lastSync(trunkRefs []string, specs []string) (*DependencyCommit, error) {
	var newest *DependencyCommit
	for _, entry := range trunkRefs {
		ref, _, _ := strings.Cut(entry, "\t")
		commit, err := g.newestTouching(ref, specs, false)
		if err != nil {
			return nil, err
		}
		if commit != nil && (newest == nil || commit.Time > newest.Time) {
			newest = commit
		}
	}
	return newest, nil
}

// findSource resolves a declaration's project among the other members of the dependent's group (FR-MC-029: within
// the same group only).
func findSource(group *molten.ProjectGroup, dependentDir string, project string) (molten.GroupMember, string) {
	if group == nil {
		return molten.GroupMember{}, "this project is in no group: add \"group\" to its .molten/project.json and to the source's"
	}
	for _, member := range group.Members {
		if member.Dir != dependentDir && molten.SameProjectName(member.Name, project) {
			return member, ""
		}
	}
	return molten.GroupMember{}, fmt.Sprintf("no other project linked to a workspace declares the group %s with the name %q", group.Name, strings.TrimSpace(project))
}

// EvaluateDependency evaluates one declaration of the dependent, on its own (FR-MC-029-AC8). prev is its last
// evaluation, if any: while none of the commits it read moved, the history is not read again.
func EvaluateDependency(ctx context.Context, run Runner, group *molten.ProjectGroup, dependentDir string, dependentName string, index int, dep molten.PipelineDependency, now time.Time, prev *DependencyState) DependencyState {
	state := DependencyState{Index: index, Project: strings.TrimSpace(dep.Project), Paths: dep.Paths, Output: dep.Output, Sync: dep.Sync, Branch: dep.Branch, CheckedAt: now.UnixMilli()}
	if problems := molten.DependencyShapeProblems(index, dep, dependentName); len(problems) > 0 {
		state.State, state.Problem = DepStateInvalid, strings.Join(problems, "; ")
		return state
	}
	source, problem := findSource(group, dependentDir, dep.Project)
	if problem != "" {
		state.State, state.Problem = DepStateSourceNotFound, problem
		return state
	}
	state.SourceDir, state.SourceName = source.Dir, source.Name
	if info, err := os.Stat(source.Dir); err != nil || !info.IsDir() {
		state.State, state.Problem = DepStateSourceNotFound, fmt.Sprintf("the folder of %s no longer exists: %s", source.Name, source.Dir)
		return state
	}
	// A partial clone would fetch the trees it lacks from its remote: the check makes no network call and writes nothing.
	ctx = WithRunEnv(ctx, "GIT_NO_LAZY_FETCH=1")
	src := &gitReader{ctx: ctx, run: run, dir: source.Dir}
	candidates := trunkCandidates(source.Dir)
	refs, err := src.readDepRefs(append([]string{state.Branch}, candidates...)...)
	if err != nil {
		state.State, state.Problem = DepStateError, fmt.Sprintf("reading %s's branches: %v", source.Name, err)
		return state
	}
	if state.Branch == "" {
		state.Branch = refs.trunk(candidates)
	}
	if state.Branch == "" {
		state.State, state.Problem = DepStateBranchNotFound, fmt.Sprintf("%s has no trunk branch to watch; declare \"branch\"", source.Name)
		return state
	}
	sourceRef := refs.watched(state.Branch)
	if sourceRef == "" {
		state.State, state.Problem = DepStateBranchNotFound, fmt.Sprintf("%s has no branch %s, local or on origin", source.Name, state.Branch)
		return state
	}
	state.Ref, state.sourceRef = shortRef(sourceRef), sourceRef
	dependent := &gitReader{ctx: ctx, run: run, dir: dependentDir}
	trunk, trunkRefs, err := dependent.dependentTrunk()
	if err != nil {
		state.State, state.Problem = DepStateError, fmt.Sprintf("reading this project's history: %v", err)
		return state
	}
	state.Trunk = trunk
	state.inputs = strings.Join(append([]string{sourceRef, refs[sourceRef]}, trunkRefs...), "\n")
	outputSpecs := depPathspecs(dep.Output)
	if prev != nil && prev.inputs == state.inputs && (prev.State == DepStateInSync || prev.Flagged()) {
		reused := *prev
		reused.CheckedAt = state.CheckedAt
		if !reused.Flagged() {
			return reused
		}
		return withUncommitted(reused, dependent, outputSpecs)
	}
	sourceCommit, err := src.newestTouching(sourceRef, depPathspecs(dep.Paths), true)
	if err != nil {
		state.State, state.Problem = DepStateError, fmt.Sprintf("reading %s's history: %v", source.Name, err)
		return state
	}
	state.Source = sourceCommit
	synced, err := dependent.lastSync(trunkRefs, outputSpecs)
	if err != nil {
		state.State, state.Problem = DepStateError, fmt.Sprintf("reading this project's history: %v", err)
		return state
	}
	state.Synced = synced
	// No commit of the source ever touched paths: there is nothing to read yet, so nothing to be behind on.
	if sourceCommit == nil || (synced != nil && sourceCommit.Time <= synced.Time) {
		state.State = DepStateInSync
		return state
	}
	var after int64
	if synced != nil {
		after = synced.Time
	}
	state.Commits, state.MoreCommits, state.Changed, err = src.commitsSince(sourceRef, depPathspecs(dep.Paths), after)
	if err != nil {
		state.State, state.Problem = DepStateError, fmt.Sprintf("reading %s's history: %v", source.Name, err)
		return state
	}
	// A change made only by a merge (a conflict resolved in paths) lists no other commit: the merge itself is named.
	if len(state.Commits) == 0 {
		state.Commits = []DependencyCommit{*sourceCommit}
	}
	return withUncommitted(state, dependent, outputSpecs)
}

// withUncommitted reads a flagged dependency's output in the worktree: changed and not committed, it is "synced, not
// committed"; the flag holds until the commit lands.
func withUncommitted(state DependencyState, dependent *gitReader, outputSpecs []string) DependencyState {
	state.State, state.Uncommitted = DepStateStale, nil
	uncommitted, err := dependent.uncommitted(outputSpecs)
	if err == nil && len(uncommitted) > 0 {
		state.State, state.Uncommitted = DepStateUncommitted, uncommitted
	}
	return state
}

// The evaluation cache: a dependency is read again on every collector refresh (DS-MC-019) and when asked afresh; a
// plain request for the groups reuses the last evaluation of the same declaration against the same source.
func depCacheKey(dependentDir string, index int, dep molten.PipelineDependency, sourceDir string) string {
	data, _ := json.Marshal(dep)
	return dependentDir + "\x00" + strconv.Itoa(index) + "\x00" + string(data) + "\x00" + sourceDir
}

func (g *Groups) cachedDep(key string) (DependencyState, bool) {
	g.lock.Lock()
	defer g.lock.Unlock()
	state, ok := g.deps[key]
	return state, ok
}

// storeDeps keeps a member's evaluations: a newer one already stored (a concurrent refresh) is never replaced by an
// older one, and the member's declarations that are gone are dropped.
func (g *Groups) storeDeps(dependentDir string, states map[string]DependencyState) {
	g.lock.Lock()
	defer g.lock.Unlock()
	if g.deps == nil {
		g.deps = map[string]DependencyState{}
	}
	prefix := dependentDir + "\x00"
	for key := range g.deps {
		if strings.HasPrefix(key, prefix) {
			if _, kept := states[key]; !kept {
				delete(g.deps, key)
			}
		}
	}
	for key, state := range states {
		if stored, ok := g.deps[key]; ok && stored.CheckedAt > state.CheckedAt {
			continue
		}
		g.deps[key] = state
	}
}

// pruneDeps drops the evaluations of the projects that are no longer members of any group.
func (g *Groups) pruneDeps(members map[string]bool) {
	g.lock.Lock()
	defer g.lock.Unlock()
	for key := range g.deps {
		dir, _, _ := strings.Cut(key, "\x00")
		if !members[dir] {
			delete(g.deps, key)
		}
	}
}

// memberDeps evaluates a member's declared dependencies; fresh reads git again, else the last evaluation is reused.
// runs are the member's run records (Runs.List), read once by the caller; nil reads them when needed.
func (g *Groups) memberDeps(group *molten.ProjectGroup, member molten.GroupMember, fresh bool, runs []RunRecord) []DependencyState {
	name, declared := g.readDeps(member.Dir)
	if len(declared) == 0 {
		g.storeDeps(member.Dir, nil)
		return nil
	}
	if name == "" {
		name = member.Name
	}
	states := make([]DependencyState, 0, len(declared))
	cache := map[string]DependencyState{}
	evaluated := false
	for i, dep := range declared {
		source, _ := findSource(group, member.Dir, dep.Project)
		key := depCacheKey(member.Dir, i, dep, source.Dir)
		cached, ok := g.cachedDep(key)
		state := cached
		if fresh || !ok {
			var prev *DependencyState
			if ok {
				prev = &cached
			}
			state = g.withAcknowledgement(member.Dir, dep, g.evaluate(group, member.Dir, name, i, dep, prev))
			evaluated = true
		}
		cache[key] = state
		states = append(states, state)
	}
	if evaluated {
		g.storeDeps(member.Dir, cache)
	}
	return g.withLastSyncs(member.Dir, states, runs)
}

func (g *Groups) evaluate(group *molten.ProjectGroup, dir string, name string, index int, dep molten.PipelineDependency, prev *DependencyState) DependencyState {
	ctx, cancel := context.WithTimeout(context.Background(), depEvaluateTimeout)
	defer cancel()
	return EvaluateDependency(ctx, g.run, group, dir, name, index, dep, g.now(), prev)
}

// Deps evaluates afresh the dependencies of the project at dir (`molten project deps`). A project in no group still
// lists its declarations, each with the source not found.
func (g *Groups) Deps(req GroupsRequest) ([]DependencyState, error) {
	if err := checkDir(req.Dir); err != nil {
		return nil, err
	}
	group, member, err := g.memberOf(filepath.Clean(req.Dir))
	if err != nil {
		return nil, err
	}
	states := g.memberDeps(group, member, true, nil)
	if states == nil {
		states = []DependencyState{}
	}
	// The groups and the notifications follow what was just read.
	go g.Refreshed()
	return states, nil
}

// memberOf is the group of the project at dir and its member entry; a project in no group is a member of none.
func (g *Groups) memberOf(dir string) (*molten.ProjectGroup, molten.GroupMember, error) {
	ctx, cancel := context.WithTimeout(context.Background(), groupsTimeout)
	defer cancel()
	links, err := g.links(ctx)
	if err != nil {
		return nil, molten.GroupMember{}, fmt.Errorf("reading the workspaces: %w", err)
	}
	groups := molten.ResolveGroups(links, g.read)
	group := molten.FindGroup(groups, dir)
	member := molten.GroupMember{Dir: dir, Name: g.read(dir).Name}
	if group != nil {
		for _, m := range group.Members {
			if m.Dir == dir {
				member = m
			}
		}
	}
	return group, member, nil
}
