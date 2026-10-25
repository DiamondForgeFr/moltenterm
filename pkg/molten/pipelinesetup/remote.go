// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/release"
)

// What the setup reads beyond the files (#1046): the release branch's protection on GitHub, through the developer's
// gh, and how far the release branch and the trunk diverged, through git on origin's refs as last fetched. Both only
// read; nothing is fetched or written.

const (
	BypassAlways           = "always"
	BypassPullRequestsOnly = "pull_requests_only"
	BypassNever            = "never"

	remoteTimeout = 60 * time.Second

	maxDivergenceSamples = 5
)

var objectIdRegex = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

type Protection struct {
	Branch string `json:"branch"`
	// The protection could be read; Error says why not (gh's own words).
	Read  bool   `json:"read"`
	Error string `json:"error,omitempty"`
	// What gh's failure means (GhMissing, GhSignedOut, GhFailed); "" when gh was not reached at all.
	Problem string `json:"problem,omitempty"`
	// What it asks of a change to the branch.
	PullRequest     bool     `json:"pullrequest"`
	RequiredChecks  []string `json:"requiredchecks"`
	Strict          bool     `json:"strict"`
	NoForcePush     bool     `json:"noforcepush"`
	RestrictUpdates bool     `json:"restrictupdates"`
	// The merge methods a pull request may use: the rules' allowed ones the repository also allows.
	MergeMethods []string `json:"mergemethods"`
	// Whether the developer may bypass it (GitHub's current_user_can_bypass, the strictest of the rules that apply):
	// always, pull_requests_only, never; "" when nothing is protected.
	Bypass string `json:"bypass,omitempty"`
	// Where each rule comes from: a ruleset (its name and id) or the classic branch protection.
	Sources []Source `json:"sources"`
}

// RequiresPr tells whether a release must reach the branch by pull request: a pull request, a required check or an
// update restriction applies and the developer cannot always bypass it.
func (p *Protection) RequiresPr() bool {
	if p == nil || !p.Read {
		return false
	}
	return (p.PullRequest || len(p.RequiredChecks) > 0 || p.RestrictUpdates) && p.Bypass != BypassAlways
}

// AllowsMerge tells whether a pull request may be merged by that method; an unread protection allows every method.
func (p *Protection) AllowsMerge(method string) bool {
	if p == nil || !p.Read || len(p.MergeMethods) == 0 {
		return true
	}
	for _, m := range p.MergeMethods {
		if m == method {
			return true
		}
	}
	return false
}

type Divergence struct {
	Trunk   string `json:"trunk"`
	Release string `json:"release"`
	Read    bool   `json:"read"`
	// Commits of the release branch the trunk does not have, and the other way round.
	Ahead  int `json:"ahead"`
	Behind int `json:"behind"`
	// Merging them conflicts (git merge-tree), in that many files.
	Conflicts     bool `json:"conflicts"`
	ConflictFiles int  `json:"conflictfiles"`
	// Commits of the release branch (merges aside) the trunk holds no equivalent of (git cherry), and the first ones.
	NotEquivalent int      `json:"notequivalent"`
	Samples       []string `json:"samples"`
}

// Diverged: each branch has commits the other lacks.
func (d *Divergence) Diverged() bool {
	return d != nil && d.Read && d.Ahead > 0 && d.Behind > 0
}

// Reconcilable: the one-time merge -s ours loses nothing, and is needed because the plain merge conflicts.
func (d *Divergence) Reconcilable() bool {
	return d.Diverged() && d.Conflicts && d.NotEquivalent == 0
}

func ghRepoArgs(repo string, path string, extra ...string) []string {
	parts := strings.Split(repo, "/")
	args := []string{"api", "repos/" + strings.Join(parts[len(parts)-2:], "/") + path}
	if len(parts) == 3 {
		args = append(args, "--hostname", parts[0])
	}
	return append(args, extra...)
}

type ruleEntry struct {
	Type       string          `json:"type"`
	Parameters json.RawMessage `json:"parameters"`
	RulesetId  int64           `json:"ruleset_id"`
}

type pullRequestParams struct {
	AllowedMergeMethods []string `json:"allowed_merge_methods"`
}

type statusChecksParams struct {
	Strict bool `json:"strict_required_status_checks_policy"`
	Checks []struct {
		Context string `json:"context"`
	} `json:"required_status_checks"`
}

var bypassRank = map[string]int{BypassNever: 0, "": 0, BypassPullRequestsOnly: 1, BypassAlways: 2}

// ReadProtection reads the branch's protection: the effective rules (rules/branches), the rulesets they come from
// (who may bypass them), the classic branch protection, and the repository's merge methods.
func ReadProtection(ctx context.Context, run Runner, dir string, branch string) *Protection {
	ctx, cancel := context.WithTimeout(ctx, remoteTimeout)
	defer cancel()
	p := &Protection{Branch: branch, RequiredChecks: []string{}, MergeMethods: []string{}, Sources: []Source{}}
	// The URL as configured, before any insteadOf rewrite: the repository GitHub knows.
	url, err := run(ctx, dir, "git", "config", "--get", "remote.origin.url")
	if err != nil {
		p.Error = "origin has no URL"
		return p
	}
	repo := release.GithubRepo(string(url))
	if repo == "" {
		p.Error = "origin is not a GitHub repository"
		return p
	}
	out, err := run(ctx, dir, "gh", ghRepoArgs(repo, "/rules/branches/"+branch)...)
	if err != nil {
		p.Error = err.Error()
		p.Problem = ghProblem(p.Error)
		return p
	}
	var rules []ruleEntry
	if err := json.Unmarshal(out, &rules); err != nil {
		p.Error = "gh api rules: unreadable answer"
		return p
	}
	p.Read = true
	bypass := BypassAlways
	imposing := false
	rulesetMethods := []string(nil)
	rulesets := map[int64]bool{}
	for _, r := range rules {
		binding := false
		switch r.Type {
		case "pull_request":
			p.PullRequest, binding = true, true
			var params pullRequestParams
			if json.Unmarshal(r.Parameters, &params) == nil && params.AllowedMergeMethods != nil {
				rulesetMethods = intersectOrFirst(rulesetMethods, params.AllowedMergeMethods)
			}
		case "required_status_checks":
			binding = true
			var params statusChecksParams
			if json.Unmarshal(r.Parameters, &params) == nil {
				p.Strict = p.Strict || params.Strict
				for _, c := range params.Checks {
					p.RequiredChecks = appendOnce(p.RequiredChecks, c.Context)
				}
			}
		case "non_fast_forward":
			p.NoForcePush = true
		case "update":
			p.RestrictUpdates, binding = true, true
		}
		if binding && r.RulesetId != 0 {
			imposing = true
			rulesets[r.RulesetId] = true
		}
	}
	ids := make([]int64, 0, len(rulesets))
	for id := range rulesets {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(a, b int) bool { return ids[a] < ids[b] })
	for _, id := range ids {
		var rs struct {
			Name   string `json:"name"`
			Bypass string `json:"current_user_can_bypass"`
		}
		out, err := run(ctx, dir, "gh", ghRepoArgs(repo, "/rulesets/"+strconv.FormatInt(id, 10))...)
		if err != nil || json.Unmarshal(out, &rs) != nil {
			rs.Bypass = ""
		}
		if bypassRank[rs.Bypass] < bypassRank[bypass] {
			bypass = rs.Bypass
			if bypass == "" {
				bypass = BypassNever
			}
		}
		p.Sources = append(p.Sources, Source{Code: "ruleset", Path: rs.Name, Detail: strconv.FormatInt(id, 10)})
	}
	var repoInfo struct {
		AllowMerge  bool `json:"allow_merge_commit"`
		AllowSquash bool `json:"allow_squash_merge"`
		AllowRebase bool `json:"allow_rebase_merge"`
		Permissions struct {
			Admin bool `json:"admin"`
		} `json:"permissions"`
	}
	repoRead := false
	if out, err := run(ctx, dir, "gh", ghRepoArgs(repo, "")...); err == nil && json.Unmarshal(out, &repoInfo) == nil {
		repoRead = true
	}
	if classic := readClassicProtection(ctx, run, dir, repo, branch); classic != nil {
		p.Sources = append(p.Sources, Source{Code: "classicProtection"})
		if classic.PullRequest || len(classic.Checks) > 0 || classic.Restricted {
			imposing = true
			p.PullRequest = p.PullRequest || classic.PullRequest
			p.RestrictUpdates = p.RestrictUpdates || classic.Restricted
			p.Strict = p.Strict || classic.Strict
			for _, c := range classic.Checks {
				p.RequiredChecks = appendOnce(p.RequiredChecks, c)
			}
			classicBypass := BypassNever
			if !classic.EnforceAdmins && repoInfo.Permissions.Admin {
				classicBypass = BypassAlways
			}
			if bypassRank[classicBypass] < bypassRank[bypass] {
				bypass = classicBypass
			}
		}
		p.NoForcePush = p.NoForcePush || !classic.AllowForcePushes
	}
	if imposing {
		p.Bypass = bypass
	}
	allowed := []string{}
	if repoRead {
		for method, ok := range map[string]bool{MergeCommit: repoInfo.AllowMerge, MergeSquash: repoInfo.AllowSquash, MergeRebase: repoInfo.AllowRebase} {
			if ok {
				allowed = append(allowed, method)
			}
		}
	} else {
		allowed = []string{MergeCommit, MergeSquash, MergeRebase}
	}
	if rulesetMethods != nil {
		allowed = intersectOrFirst(rulesetMethods, allowed)
	}
	order := map[string]int{MergeCommit: 0, MergeSquash: 1, MergeRebase: 2}
	sort.Slice(allowed, func(a, b int) bool { return order[allowed[a]] < order[allowed[b]] })
	p.MergeMethods = allowed
	return p
}

// intersectOrFirst: the items of b also in a; a nil a is no constraint yet.
func intersectOrFirst(a []string, b []string) []string {
	if a == nil {
		return append([]string{}, b...)
	}
	rtn := []string{}
	for _, x := range b {
		for _, y := range a {
			if x == y {
				rtn = append(rtn, x)
				break
			}
		}
	}
	return rtn
}

type classicProtection struct {
	PullRequest      bool
	Checks           []string
	Strict           bool
	Restricted       bool
	EnforceAdmins    bool
	AllowForcePushes bool
}

// readClassicProtection reads the branch protection of the repository's settings; nil when there is none, or when the
// developer may not read it (it needs the admin permission).
func readClassicProtection(ctx context.Context, run Runner, dir string, repo string, branch string) *classicProtection {
	out, err := run(ctx, dir, "gh", ghRepoArgs(repo, "/branches/"+branch+"/protection")...)
	if err != nil {
		return nil
	}
	var bp struct {
		Reviews *struct{} `json:"required_pull_request_reviews"`
		Checks  *struct {
			Strict   bool     `json:"strict"`
			Contexts []string `json:"contexts"`
		} `json:"required_status_checks"`
		EnforceAdmins *struct {
			Enabled bool `json:"enabled"`
		} `json:"enforce_admins"`
		Restrictions *struct{} `json:"restrictions"`
		ForcePushes  *struct {
			Enabled bool `json:"enabled"`
		} `json:"allow_force_pushes"`
		LockBranch *struct {
			Enabled bool `json:"enabled"`
		} `json:"lock_branch"`
	}
	if json.Unmarshal(out, &bp) != nil {
		return nil
	}
	rtn := &classicProtection{PullRequest: bp.Reviews != nil, Restricted: bp.Restrictions != nil || (bp.LockBranch != nil && bp.LockBranch.Enabled)}
	if bp.Checks != nil {
		rtn.Strict = bp.Checks.Strict
		rtn.Checks = bp.Checks.Contexts
	}
	rtn.EnforceAdmins = bp.EnforceAdmins != nil && bp.EnforceAdmins.Enabled
	rtn.AllowForcePushes = bp.ForcePushes != nil && bp.ForcePushes.Enabled
	return rtn
}

// ReadDivergence compares origin's release branch with its trunk as last fetched.
func ReadDivergence(ctx context.Context, run Runner, dir string, trunk string, releaseBranch string) *Divergence {
	ctx, cancel := context.WithTimeout(ctx, remoteTimeout)
	defer cancel()
	d := &Divergence{Trunk: trunk, Release: releaseBranch, Samples: []string{}}
	trunkRef, releaseRef := "origin/"+trunk, "origin/"+releaseBranch
	out, err := run(ctx, dir, "git", "rev-list", "--left-right", "--count", releaseRef+"..."+trunkRef)
	if err != nil {
		return d
	}
	if _, err := fmt.Sscanf(strings.TrimSpace(string(out)), "%d %d", &d.Ahead, &d.Behind); err != nil {
		return d
	}
	d.Read = true
	if d.Ahead == 0 {
		return d
	}
	// A conflicting merge exits 1 after the tree's id and the conflicted files; any other failure (a git older than
	// merge-tree --write-tree) prints no tree and says nothing about conflicts.
	if out, err := run(ctx, dir, "git", "merge-tree", "--write-tree", "--name-only", "--no-messages", releaseRef, trunkRef); err != nil {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		if len(lines) > 0 && objectIdRegex.MatchString(lines[0]) {
			d.Conflicts = true
			d.ConflictFiles = len(lines) - 1
		}
	}
	out, err = run(ctx, dir, "git", "log", "--no-merges", "--right-only", "--cherry-pick", "--format=%h %s", trunkRef+"..."+releaseRef)
	if err != nil {
		return d
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		d.NotEquivalent++
		if len(d.Samples) < maxDivergenceSamples {
			d.Samples = append(d.Samples, line)
		}
	}
	return d
}
