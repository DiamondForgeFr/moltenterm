// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package forecast simulates merging open pull requests one onto another (FR-REV-023, DS-REV-016, NFR-REV-009): for
// each PR A waiting for review, the base with A merged by the repository's method, then every other open PR B on top
// of that result. B is impacted when it merges cleanly onto the base today and conflicts once A is in.
//
// Everything runs in a private bare repository that borrows the project's objects through objects/info/alternates:
// git merge-tree computes the merges in memory, the merge results become commits of that private store only, and a
// commit the project lacks is fetched from origin into it. The developer's checkout, worktrees, branches and GitHub are
// never written. Results are cached by commit ids, so a push to one PR recomputes only that PR's pairs.
package forecast

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

const (
	MethodMerge  = "merge"
	MethodSquash = "squash"
	MethodRebase = "rebase"

	// A row's state: its merge was simulated, it conflicts with the base already, or its head commit is not available.
	RowSimulated     = "simulated"
	RowConflictsBase = "conflictsbase"
	RowMissing       = "missing"

	// The conflicting paths kept per pair; PathCount says how many there were.
	MaxPaths = 30

	// The identity and date of the merge results written in the private store: fixed, so the same merge always gives
	// the same commit.
	resultName  = "MoltenTerm forecast"
	resultEmail = "forecast@moltenterm.invalid"
	resultDate  = "1700000000 +0000"
)

var oidRe = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)
var branchRe = regexp.MustCompile(`^[A-Za-z0-9._/@+-]+$`)

// ErrBaseMissing: the base commit is neither in the project nor on origin.
var ErrBaseMissing = errors.New("the base commit could not be found in the project or on origin")

// Git runs git with input on its standard input (none when nil) and env added to its environment.
type Git func(ctx context.Context, input []byte, env []string, args ...string) ([]byte, error)

// Pr is an open PR of the forecast. Ready: waiting for review, its merge is simulated; the others (drafts) are only
// checked on top of the ready ones' merges.
type Pr struct {
	Number  int    `json:"number"`
	Branch  string `json:"branch"`
	HeadOid string `json:"headoid"`
	Ready   bool   `json:"ready,omitempty"`
}

type Input struct {
	// Dir is the project's checkout, only read: its object store and its origin's URL.
	Dir     string
	Base    string
	BaseOid string
	Method  string
	Prs     []Pr
}

// Impact is a PR a merge puts in conflict, with the paths that conflict.
type Impact struct {
	Number    int      `json:"number"`
	HeadOid   string   `json:"headoid"`
	Paths     []string `json:"paths"`
	PathCount int      `json:"pathcount"`
}

type Row struct {
	Number  int    `json:"number"`
	HeadOid string `json:"headoid"`
	State   string `json:"state"`
	// Impacts: the open PRs merging this one puts in conflict (ready PRs only), by number.
	Impacts []Impact `json:"impacts"`
	// BasePaths: the paths in conflict with the base (RowConflictsBase).
	BasePaths []string `json:"basepaths,omitempty"`
}

// Stats says what a computation ran: merges onto the base and pairs simulated, pairs answered from the cache, and
// heads fetched from origin.
type Stats struct {
	Merges  int `json:"merges"`
	Pairs   int `json:"pairs"`
	Reused  int `json:"reused"`
	Fetched int `json:"fetched"`
}

type Result struct {
	BaseOid string `json:"baseoid"`
	Method  string `json:"method"`
	// Approximate: a rebase merge is simulated as the tree of a merge of the PR (the commits are not replayed one by
	// one), which differs only when a rebase stops on a conflict a merge resolves.
	Approximate bool  `json:"approximate,omitempty"`
	Rows        []Row `json:"rows"`
	Stats       Stats `json:"stats"`
}

type mergeResult struct {
	clean bool
	tree  string
	paths []string
}

// Engine is one project's forecast: its private store and its cache. One computation runs at a time.
type Engine struct {
	git   Git
	store string

	run sync.Mutex

	lock    sync.Mutex
	base    string
	merges  map[string]mergeResult
	commits map[string]string
	pairs   map[string]mergeResult
}

// MakeEngine makes the forecast of a project whose private store is the bare repository at store.
func MakeEngine(git Git, store string) *Engine {
	return &Engine{git: git, store: store, merges: map[string]mergeResult{}, commits: map[string]string{}, pairs: map[string]mergeResult{}}
}

func ValidOid(oid string) bool {
	return oidRe.MatchString(oid)
}

func validBranch(name string) bool {
	return branchRe.MatchString(name) && !strings.Contains(name, "..") && !strings.HasPrefix(name, "-") &&
		!strings.HasPrefix(name, "/") && !strings.HasSuffix(name, "/") && !strings.HasSuffix(name, ".lock")
}

func validMethod(method string) bool {
	return method == MethodMerge || method == MethodSquash || method == MethodRebase
}

func checkInput(in Input) error {
	if !filepath.IsAbs(in.Dir) {
		return errors.New("the project folder must be an absolute path")
	}
	if !validBranch(in.Base) || !ValidOid(in.BaseOid) {
		return errors.New("the base must be a branch name and a commit id")
	}
	if !validMethod(in.Method) {
		return fmt.Errorf("unknown merge method %q", in.Method)
	}
	seen := map[int]bool{}
	for _, pr := range in.Prs {
		if pr.Number <= 0 || seen[pr.Number] || !validBranch(pr.Branch) || !ValidOid(pr.HeadOid) {
			return fmt.Errorf("PR #%d must name its branch and head commit once", pr.Number)
		}
		seen[pr.Number] = true
	}
	return nil
}

func (e *Engine) storeGit(ctx context.Context, input []byte, env []string, args ...string) ([]byte, error) {
	// No hook of the developer's configuration runs in the private store.
	full := append([]string{"--git-dir=" + e.store, "-c", "core.hooksPath=" + os.DevNull}, args...)
	return e.git(ctx, input, env, full...)
}

// Compute runs the forecast of in, reusing every merge and pair already simulated on the same commits.
func (e *Engine) Compute(ctx context.Context, in Input) (Result, error) {
	if err := checkInput(in); err != nil {
		return Result{}, err
	}
	e.run.Lock()
	defer e.run.Unlock()
	if err := e.ensureStore(ctx, in.Dir); err != nil {
		return Result{}, err
	}
	result := Result{BaseOid: in.BaseOid, Method: in.Method, Approximate: in.Method == MethodRebase, Rows: []Row{}}
	present, fetched, err := e.ensureCommits(ctx, in)
	if err != nil {
		return Result{}, err
	}
	result.Stats.Fetched = fetched
	e.resetFor(in.BaseOid)
	if err := e.mergeOntoBase(ctx, in, present, &result.Stats); err != nil {
		e.resetFor("")
		return Result{}, err
	}
	// A merge result the store's housekeeping dropped fails the merges: the cache is dropped with it.
	if err := e.mergePairs(ctx, in, present, &result.Stats); err != nil {
		e.resetFor("")
		return Result{}, err
	}
	result.Rows = e.rowsOf(in, present)
	e.prune(in)
	// Housekeeping of the private store only: the merge results' loose objects are packed and old ones dropped.
	_, _ = e.storeGit(ctx, nil, nil, "gc", "--auto", "--quiet")
	return result, nil
}

// ensureStore creates the private bare store and points its alternates at the project's object store.
func (e *Engine) ensureStore(ctx context.Context, dir string) error {
	if _, err := os.Stat(filepath.Join(e.store, "HEAD")); err != nil {
		if err := os.MkdirAll(filepath.Dir(e.store), 0700); err != nil {
			return err
		}
		if _, err := e.git(ctx, nil, nil, "init", "--bare", "--quiet", e.store); err != nil {
			return err
		}
	}
	out, err := e.git(ctx, nil, nil, "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return fmt.Errorf("the project is not a git repository: %w", err)
	}
	objects := filepath.Join(strings.TrimSpace(string(out)), "objects")
	file := filepath.Join(e.store, "objects", "info", "alternates")
	if current, err := os.ReadFile(file); err == nil && strings.TrimSpace(string(current)) == objects {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	return os.WriteFile(file, []byte(objects+"\n"), 0600)
}

// missingCommits lists the oids the store (with the project's objects) cannot read as commits.
func (e *Engine) missingCommits(ctx context.Context, oids []string) (map[string]bool, error) {
	var input strings.Builder
	for _, oid := range oids {
		input.WriteString(oid + "\n")
	}
	out, err := e.storeGit(ctx, []byte(input.String()), nil, "cat-file", "--batch-check")
	if err != nil {
		return nil, err
	}
	missing := map[string]bool{}
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	for i, oid := range oids {
		if i >= len(lines) {
			missing[oid] = true
			continue
		}
		fields := strings.Fields(lines[i])
		if len(fields) < 2 || fields[0] != oid || fields[1] != "commit" {
			missing[oid] = true
		}
	}
	return missing, nil
}

// ensureCommits fetches from origin the branches whose commit is missing, into the private store's refs/forecast/.
// It answers the PR heads now present; the base must be.
func (e *Engine) ensureCommits(ctx context.Context, in Input) (map[string]bool, int, error) {
	oids := []string{in.BaseOid}
	for _, pr := range in.Prs {
		oids = append(oids, pr.HeadOid)
	}
	missing, err := e.missingCommits(ctx, oids)
	if err != nil {
		return nil, 0, err
	}
	fetched := 0
	if len(missing) > 0 {
		var refspecs []string
		if missing[in.BaseOid] {
			refspecs = append(refspecs, "+refs/heads/"+in.Base+":refs/forecast/heads/"+in.Base)
		}
		for _, pr := range in.Prs {
			if missing[pr.HeadOid] {
				refspecs = append(refspecs, "+refs/heads/"+pr.Branch+":refs/forecast/heads/"+pr.Branch)
			}
		}
		e.fetch(ctx, in.Dir, refspecs)
		again, err := e.missingCommits(ctx, oids)
		if err != nil {
			return nil, 0, err
		}
		fetched = len(missing) - len(again)
		missing = again
	}
	if missing[in.BaseOid] {
		return nil, fetched, ErrBaseMissing
	}
	present := map[string]bool{in.BaseOid: true}
	for _, pr := range in.Prs {
		if !missing[pr.HeadOid] {
			present[pr.HeadOid] = true
		}
	}
	return present, fetched, nil
}

// fetch reads branches from the project's origin into the private store. A branch gone from origin is not an error:
// its PR is reported missing.
func (e *Engine) fetch(ctx context.Context, dir string, refspecs []string) {
	out, err := e.git(ctx, nil, nil, "-C", dir, "remote", "get-url", "origin")
	if err != nil {
		return
	}
	url := strings.TrimSpace(string(out))
	if url == "" || strings.HasPrefix(url, "-") {
		return
	}
	env := []string{"GIT_TERMINAL_PROMPT=0"}
	args := append([]string{"fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", url}, refspecs...)
	if _, err := e.storeGit(ctx, nil, env, args...); err == nil {
		return
	}
	// One branch gone makes the whole fetch fail: each is tried alone then.
	for _, refspec := range refspecs {
		_, _ = e.storeGit(ctx, nil, env, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", url, refspec)
	}
}

// resetFor drops the cache when the base moved: every merge depends on it.
func (e *Engine) resetFor(baseOid string) {
	e.lock.Lock()
	defer e.lock.Unlock()
	if e.base == baseOid {
		return
	}
	e.base = baseOid
	e.merges = map[string]mergeResult{}
	e.commits = map[string]string{}
	e.pairs = map[string]mergeResult{}
}

func (e *Engine) cachedMerge(head string) (mergeResult, bool) {
	e.lock.Lock()
	defer e.lock.Unlock()
	r, ok := e.merges[head]
	return r, ok
}

func (e *Engine) keepMerge(head string, r mergeResult) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.merges[head] = r
}

func (e *Engine) cachedCommit(key string) (string, bool) {
	e.lock.Lock()
	defer e.lock.Unlock()
	c, ok := e.commits[key]
	return c, ok
}

func (e *Engine) keepCommit(key string, commit string) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.commits[key] = commit
}

func (e *Engine) cachedPair(key string) (mergeResult, bool) {
	e.lock.Lock()
	defer e.lock.Unlock()
	r, ok := e.pairs[key]
	return r, ok
}

func (e *Engine) keepPair(key string, r mergeResult) {
	e.lock.Lock()
	defer e.lock.Unlock()
	e.pairs[key] = r
}

func pairKey(method string, a string, b string) string {
	return method + ":" + a + ":" + b
}

func commitKey(method string, a string) string {
	return method + ":" + a
}

// mergeTree runs every merge of lines ("<commit> <commit>") in one git merge-tree process, in memory.
func (e *Engine) mergeTree(ctx context.Context, lines [][2]string) ([]mergeResult, error) {
	if len(lines) == 0 {
		return nil, nil
	}
	var input strings.Builder
	for _, l := range lines {
		input.WriteString(l[0] + " " + l[1] + "\n")
	}
	out, err := e.storeGit(ctx, []byte(input.String()), nil, "merge-tree", "--stdin", "-z", "--name-only", "--no-messages")
	if err != nil {
		return nil, err
	}
	return parseMergeTree(out, len(lines))
}

// parseMergeTree reads merge-tree --stdin -z --name-only --no-messages: per merge, its status (1 clean, 0 conflicts),
// the result tree, the conflicting paths, then an empty field.
func parseMergeTree(out []byte, count int) ([]mergeResult, error) {
	fields := strings.Split(string(out), "\x00")
	rtn := make([]mergeResult, 0, count)
	i := 0
	for len(rtn) < count {
		if i+1 >= len(fields) {
			return nil, errors.New("git merge-tree answered fewer merges than asked")
		}
		status, tree := fields[i], fields[i+1]
		if (status != "0" && status != "1") || !ValidOid(tree) {
			return nil, errors.New("git merge-tree answered something unreadable")
		}
		i += 2
		r := mergeResult{clean: status == "1", tree: tree}
		seen := map[string]bool{}
		for i < len(fields) && fields[i] != "" {
			if !seen[fields[i]] {
				seen[fields[i]] = true
				r.paths = append(r.paths, fields[i])
			}
			i++
		}
		i++
		sort.Strings(r.paths)
		rtn = append(rtn, r)
	}
	return rtn, nil
}

// mergeOntoBase simulates every present PR merged onto the base: the ready ones' results are the bases of the pairs,
// and a PR already in conflict with the base is not counted as impacted.
func (e *Engine) mergeOntoBase(ctx context.Context, in Input, present map[string]bool, stats *Stats) error {
	var lines [][2]string
	var heads []string
	for _, pr := range in.Prs {
		if !present[pr.HeadOid] {
			continue
		}
		if _, ok := e.cachedMerge(pr.HeadOid); ok {
			continue
		}
		lines = append(lines, [2]string{in.BaseOid, pr.HeadOid})
		heads = append(heads, pr.HeadOid)
	}
	results, err := e.mergeTree(ctx, lines)
	if err != nil {
		return err
	}
	for i, r := range results {
		e.keepMerge(heads[i], r)
	}
	stats.Merges = len(results)
	for _, pr := range in.Prs {
		if !pr.Ready || !present[pr.HeadOid] {
			continue
		}
		merged, _ := e.cachedMerge(pr.HeadOid)
		if !merged.clean {
			continue
		}
		key := commitKey(in.Method, pr.HeadOid)
		if _, ok := e.cachedCommit(key); ok {
			continue
		}
		commit, err := e.resultCommit(ctx, in, pr.HeadOid, merged.tree)
		if err != nil {
			return err
		}
		e.keepCommit(key, commit)
	}
	return nil
}

// resultCommit writes the base after the merge as a commit of the private store: a merge commit has the base and the
// PR as parents; a squash, and a rebase as approximated, a single parent, the base.
func (e *Engine) resultCommit(ctx context.Context, in Input, head string, tree string) (string, error) {
	// A signing configured by the developer would ask for a key: these commits never leave the private store.
	args := []string{"commit-tree", "--no-gpg-sign", tree, "-p", in.BaseOid}
	if in.Method == MethodMerge {
		args = append(args, "-p", head)
	}
	args = append(args, "-m", "forecast")
	env := []string{
		"GIT_AUTHOR_NAME=" + resultName, "GIT_AUTHOR_EMAIL=" + resultEmail, "GIT_AUTHOR_DATE=" + resultDate,
		"GIT_COMMITTER_NAME=" + resultName, "GIT_COMMITTER_EMAIL=" + resultEmail, "GIT_COMMITTER_DATE=" + resultDate,
	}
	out, err := e.storeGit(ctx, nil, env, args...)
	if err != nil {
		return "", err
	}
	commit := strings.TrimSpace(string(out))
	if !ValidOid(commit) {
		return "", errors.New("git commit-tree answered something unreadable")
	}
	return commit, nil
}

// cleanOnBase: the PR is present and merges cleanly onto the base.
func (e *Engine) cleanOnBase(pr Pr, present map[string]bool) bool {
	if !present[pr.HeadOid] {
		return false
	}
	merged, ok := e.cachedMerge(pr.HeadOid)
	return ok && merged.clean
}

// mergePairs simulates every other PR B on top of each ready PR A's merge, unless the cache has the pair.
func (e *Engine) mergePairs(ctx context.Context, in Input, present map[string]bool, stats *Stats) error {
	var lines [][2]string
	var keys []string
	for _, a := range in.Prs {
		if !a.Ready || !e.cleanOnBase(a, present) {
			continue
		}
		commit, _ := e.cachedCommit(commitKey(in.Method, a.HeadOid))
		for _, b := range in.Prs {
			if b.Number == a.Number || !e.cleanOnBase(b, present) {
				continue
			}
			key := pairKey(in.Method, a.HeadOid, b.HeadOid)
			if _, ok := e.cachedPair(key); ok {
				stats.Reused++
				continue
			}
			lines = append(lines, [2]string{commit, b.HeadOid})
			keys = append(keys, key)
		}
	}
	results, err := e.mergeTree(ctx, lines)
	if err != nil {
		return err
	}
	for i, r := range results {
		e.keepPair(keys[i], mergeResult{clean: r.clean, paths: r.paths})
	}
	stats.Pairs = len(results)
	return nil
}

func capPaths(paths []string) []string {
	if len(paths) > MaxPaths {
		return append([]string{}, paths[:MaxPaths]...)
	}
	return append([]string{}, paths...)
}

func (e *Engine) rowsOf(in Input, present map[string]bool) []Row {
	rows := []Row{}
	for _, a := range in.Prs {
		row := Row{Number: a.Number, HeadOid: a.HeadOid, State: RowSimulated, Impacts: []Impact{}}
		merged, ok := e.cachedMerge(a.HeadOid)
		switch {
		case !present[a.HeadOid] || !ok:
			row.State = RowMissing
		case !merged.clean:
			row.State = RowConflictsBase
			row.BasePaths = capPaths(merged.paths)
		case a.Ready:
			for _, b := range in.Prs {
				if b.Number == a.Number {
					continue
				}
				pair, ok := e.cachedPair(pairKey(in.Method, a.HeadOid, b.HeadOid))
				if !ok || pair.clean {
					continue
				}
				row.Impacts = append(row.Impacts, Impact{Number: b.Number, HeadOid: b.HeadOid, Paths: capPaths(pair.paths), PathCount: len(pair.paths)})
			}
			sort.Slice(row.Impacts, func(i, j int) bool { return row.Impacts[i].Number < row.Impacts[j].Number })
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Number < rows[j].Number })
	return rows
}

// prune keeps in the cache only the heads still listed.
func (e *Engine) prune(in Input) {
	heads := map[string]bool{}
	for _, pr := range in.Prs {
		heads[pr.HeadOid] = true
	}
	e.lock.Lock()
	defer e.lock.Unlock()
	for head := range e.merges {
		if !heads[head] {
			delete(e.merges, head)
		}
	}
	for key := range e.commits {
		if parts := strings.Split(key, ":"); !heads[parts[len(parts)-1]] {
			delete(e.commits, key)
		}
	}
	for key := range e.pairs {
		parts := strings.Split(key, ":")
		if len(parts) != 3 || !heads[parts[1]] || !heads[parts[2]] {
			delete(e.pairs, key)
		}
	}
}
