// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
)

// The merge method of Validate (#673): the methods the repository allows on GitHub (allow_merge_commit,
// allow_squash_merge, allow_rebase_merge), narrowed by the rules of the base branch (a ruleset's allowed methods, a
// required linear history, a merge queue that sets its own method). The default is the method last used for the
// repository from MoltenTerm, else the only one allowed, else GitHub's own order. What GitHub answered is kept for the
// session; a failed read is not kept, and a merge GitHub refused drops it.

const (
	MergeMethodMerge  = "merge"
	MergeMethodSquash = "squash"

	// What narrowed the methods (MergePlan.MethodRule).
	MethodRuleQueue   = "queue"
	MethodRuleRuleset = "ruleset"
	MethodRuleLinear  = "linear"

	mergePrefsFileName = "merge.json"
)

// GitHub's own order, which the default follows when nothing else decides.
var allMergeMethods = []string{MergeMethodMerge, MergeMethodSquash, MergeMethodRebase}

type ghRepoMerge struct {
	AllowMergeCommit *bool `json:"allow_merge_commit"`
	AllowSquashMerge *bool `json:"allow_squash_merge"`
	AllowRebaseMerge *bool `json:"allow_rebase_merge"`
}

type ghRule struct {
	Type       string `json:"type"`
	Parameters struct {
		AllowedMergeMethods []string `json:"allowed_merge_methods"`
		MergeMethod         string   `json:"merge_method"`
	} `json:"parameters"`
}

// repoMethods is what GitHub says of a repository's merges; branchRules what it says of a base branch's.
type repoMethods struct {
	methods []string
}

type branchRules struct {
	allowed []string
	linear  bool
	queue   string
}

// mergeMethods is the plan's part about the method.
type mergeMethods struct {
	methods []string
	method  string
	rule    string
	queue   bool
}

type mergePrefs struct {
	LastMethod string `json:"lastmethod,omitempty"`
}

func ValidMergeMethod(method string) bool {
	for _, m := range allMergeMethods {
		if m == method {
			return true
		}
	}
	return false
}

func hasMethod(methods []string, method string) bool {
	for _, m := range methods {
		if m == method {
			return true
		}
	}
	return false
}

// inOrder lists, in GitHub's order, the methods keep accepts.
func inOrder(keep func(method string) bool) []string {
	rtn := []string{}
	for _, m := range allMergeMethods {
		if keep(m) {
			rtn = append(rtn, m)
		}
	}
	return rtn
}

// parseRepoMethods: a field GitHub leaves out (a token that cannot read it) counts as allowed; GitHub refuses the merge
// itself if it is not.
func parseRepoMethods(out []byte) (repoMethods, error) {
	var repo ghRepoMerge
	if err := json.Unmarshal(out, &repo); err != nil {
		return repoMethods{}, errors.New("gh api answered something unreadable about the repository")
	}
	allowed := map[string]*bool{
		MergeMethodMerge:  repo.AllowMergeCommit,
		MergeMethodSquash: repo.AllowSquashMerge,
		MergeMethodRebase: repo.AllowRebaseMerge,
	}
	methods := inOrder(func(m string) bool { return allowed[m] == nil || *allowed[m] })
	if len(methods) == 0 {
		methods = append([]string{}, allMergeMethods...)
	}
	return repoMethods{methods: methods}, nil
}

func parseBranchRules(out []byte) (branchRules, error) {
	var rules []ghRule
	if err := json.Unmarshal(out, &rules); err != nil {
		return branchRules{}, errors.New("gh api answered something unreadable about the branch rules")
	}
	var rtn branchRules
	for _, r := range rules {
		switch r.Type {
		case "required_linear_history":
			rtn.linear = true
		case "merge_queue":
			if m := strings.ToLower(r.Parameters.MergeMethod); ValidMergeMethod(m) {
				rtn.queue = m
			} else {
				rtn.queue = MergeMethodMerge
			}
		case "pull_request":
			if len(r.Parameters.AllowedMergeMethods) == 0 {
				continue
			}
			allowed := map[string]bool{}
			for _, m := range r.Parameters.AllowedMergeMethods {
				allowed[strings.ToLower(m)] = true
			}
			if rtn.allowed != nil {
				// Several rulesets: a method must pass them all.
				prev := rtn.allowed
				rtn.allowed = inOrder(func(m string) bool { return allowed[m] && hasMethod(prev, m) })
			} else {
				rtn.allowed = inOrder(func(m string) bool { return allowed[m] })
			}
		}
	}
	return rtn, nil
}

// chooseMethods combines the repository, the base's rules and the last method used into the plan's methods.
func chooseMethods(repo repoMethods, rules branchRules, last string) mergeMethods {
	if rules.queue != "" {
		return mergeMethods{methods: []string{rules.queue}, method: rules.queue, rule: MethodRuleQueue, queue: true}
	}
	rtn := mergeMethods{methods: repo.methods}
	if rules.allowed != nil {
		narrowed := inOrder(func(m string) bool { return hasMethod(rules.allowed, m) && hasMethod(repo.methods, m) })
		if len(narrowed) == 0 {
			narrowed = rules.allowed
		}
		if len(narrowed) < len(rtn.methods) {
			rtn.rule = MethodRuleRuleset
		}
		rtn.methods = narrowed
	}
	if rules.linear && hasMethod(rtn.methods, MergeMethodMerge) && len(rtn.methods) > 1 {
		rtn.methods = inOrder(func(m string) bool { return m != MergeMethodMerge && hasMethod(rtn.methods, m) })
		if rtn.rule == "" {
			rtn.rule = MethodRuleLinear
		}
	}
	switch {
	case hasMethod(rtn.methods, last):
		rtn.method = last
	case len(rtn.methods) > 0:
		rtn.method = rtn.methods[0]
	default:
		rtn.methods = append([]string{}, allMergeMethods...)
		rtn.method = MergeMethodMerge
	}
	return rtn
}

// runGhApi runs gh api, which names the repository in its path (it takes no --repo).
func (m *Merger) runGhApi(ctx context.Context, dir string, path string) ([]byte, error) {
	if m.gh == nil {
		return nil, noGhError()
	}
	ctx, cancel := context.WithTimeout(ctx, ghCallTimeout)
	defer cancel()
	out, err := m.gh(ctx, dir, "api", path)
	if err != nil {
		return out, errors.New(maskTokens(err.Error()))
	}
	return out, nil
}

func (m *Merger) cachedRepo(repo string) (repoMethods, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	r, ok := m.repoMethods[repo]
	return r, ok
}

func (m *Merger) cachedRules(key string) (branchRules, bool) {
	m.lock.Lock()
	defer m.lock.Unlock()
	r, ok := m.branchRules[key]
	return r, ok
}

func (m *Merger) keepRepo(repo string, r repoMethods) {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.repoMethods[repo] = r
}

func (m *Merger) keepRules(key string, r branchRules) {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.branchRules[key] = r
}

// forgetMethods drops what GitHub said of the repository: its settings may have changed since.
func (m *Merger) forgetMethods(repo string) {
	m.lock.Lock()
	defer m.lock.Unlock()
	delete(m.repoMethods, repo)
	for key := range m.branchRules {
		if strings.HasPrefix(key, repo+"\x00") {
			delete(m.branchRules, key)
		}
	}
}

func (m *Merger) readRepoMethods(ctx context.Context, dir string, repo string) repoMethods {
	if r, ok := m.cachedRepo(repo); ok {
		return r
	}
	out, err := m.runGhApi(ctx, dir, "repos/"+repo)
	if err != nil {
		return repoMethods{methods: append([]string{}, allMergeMethods...)}
	}
	r, err := parseRepoMethods(out)
	if err != nil {
		return repoMethods{methods: append([]string{}, allMergeMethods...)}
	}
	m.keepRepo(repo, r)
	return r
}

func (m *Merger) readBranchRules(ctx context.Context, dir string, repo string, base string) branchRules {
	if !reviewsession.ValidRef(base) {
		return branchRules{}
	}
	key := repo + "\x00" + base
	if r, ok := m.cachedRules(key); ok {
		return r
	}
	out, err := m.runGhApi(ctx, dir, "repos/"+repo+"/rules/branches/"+url.PathEscape(base))
	if err != nil {
		return branchRules{}
	}
	r, err := parseBranchRules(out)
	if err != nil {
		return branchRules{}
	}
	m.keepRules(key, r)
	return r
}

func (m *Merger) planMethods(ctx context.Context, dir string, repo string, base string) mergeMethods {
	last, _ := m.store.LastMergeMethod(repo)
	return chooseMethods(m.readRepoMethods(ctx, dir, repo), m.readBranchRules(ctx, dir, repo, base), last)
}

// updateBranchArgs: a rebase merge keeps the history linear, so GitHub rebases a branch behind its base; a merge
// commit or a squash takes a merge of the base instead, which keeps the commits already reviewed.
func updateBranchArgs(number string, method string) []string {
	if method == MergeMethodRebase {
		return []string{"pr", "update-branch", number, "--rebase"}
	}
	return []string{"pr", "update-branch", number}
}

// mergeArgs: a squash takes the commit title and message the repository sets (no --subject or --body); a merge queue
// merges by itself, and the remote branch is then the cleanup's (it deletes it only at the head GitHub merged).
func mergeArgs(number string, method string, queue bool, head string) []string {
	args := []string{"pr", "merge", number, "--" + method}
	if !queue {
		args = append(args, "--delete-branch")
	}
	return append(args, "--match-head-commit", head)
}

func (s *Store) mergePrefsFile(repo string) string {
	return filepath.Join(s.dir, RepoKey(repo), mergePrefsFileName)
}

// LastMergeMethod is the method last used for the repository from MoltenTerm ("" when none).
func (s *Store) LastMergeMethod(repo string) (string, error) {
	if err := checkRepo(repo); err != nil {
		return "", err
	}
	file := s.mergePrefsFile(repo)
	lock := s.fileLock(file)
	lock.Lock()
	defer lock.Unlock()
	data, err := os.ReadFile(file)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	var prefs mergePrefs
	if err := json.Unmarshal(data, &prefs); err != nil || !ValidMergeMethod(prefs.LastMethod) {
		return "", nil
	}
	return prefs.LastMethod, nil
}

func (s *Store) SetLastMergeMethod(repo string, method string) error {
	if err := checkRepo(repo); err != nil {
		return err
	}
	if !ValidMergeMethod(method) {
		return errors.New("unknown merge method")
	}
	file := s.mergePrefsFile(repo)
	lock := s.fileLock(file)
	lock.Lock()
	defer lock.Unlock()
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(mergePrefs{LastMethod: method}, "", "  ")
	if err != nil {
		return err
	}
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// waitQueue waits until the merge queue merged the PR. Stopping the wait leaves the PR in the queue: GitHub may still
// merge it, and the cleanup can then be run from the Review tab.
func (m *Merger) waitQueue(ctx context.Context, plan MergePlan, record MergeRecord, head string) (ghMergePr, MergeRecord, bool) {
	k := PrKey{Repo: plan.Repo, Number: plan.Number}
	record.State = MergeQueued
	m.record(k, record)
	deadline := m.now().Add(m.ciTimeout)
	failures := 0
	for {
		if !m.sleep(ctx, m.pollEvery) {
			m.end(k, record, MergeCancelled, "", MergeCodeQueueStopped, nil)
			return ghMergePr{}, record, false
		}
		if m.now().After(deadline) {
			record.Minutes = int(m.ciTimeout.Minutes())
			m.end(k, record, MergeFailed, "", MergeCodeQueueTimeout, nil)
			return ghMergePr{}, record, false
		}
		pr, err := m.viewPr(ctx, plan.Dir, k)
		if err != nil {
			failures++
			if failures >= maxPollErrors {
				m.end(k, record, MergeFailed, "", MergeCodePollError, err)
				return ghMergePr{}, record, false
			}
			continue
		}
		failures = 0
		switch {
		case strings.EqualFold(pr.State, "MERGED"):
			return pr, record, true
		case !strings.EqualFold(pr.State, "OPEN"):
			m.end(k, record, MergeFailed, "", MergeCodeQueueClosed, nil)
			return ghMergePr{}, record, false
		case pr.HeadRefOid != head:
			m.end(k, headMoved(record, pr.HeadRefOid, head), MergeRefused, RefusedHeadMoved, MergeCodeHeadMoved, nil)
			return ghMergePr{}, record, false
		}
	}
}
