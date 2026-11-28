// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"context"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// A trunk that is red with no open pull request (FR-REV-036 AC16): the scan the project declared, or the developer
// confirmed, fails on the trunk's own latest commit. No pull request is blocked, so no pull request's check leads here: the
// trunk's checks are read instead, and a block with no pull request says the scan blocks the trunk.

// watchesTrunk: the assessment is asked to read the trunk, and the project names its scan, so its trunk is worth reading
// even when every pull request is green.
func (in Input) watchesTrunk() bool {
	return in.WatchTrunk && in.Trunk != "" && ((in.Policy.Declaration != nil && len(in.Policy.Declaration.Checks) > 0) || len(in.Policy.Confirmed) > 0)
}

// TrunkOnly is what the result holds that no pull request is part of: the blocks of the trunk's own red scan.
func (r Result) TrunkOnly() Result {
	out := Result{Blocks: []Block{}, Offers: []Offer{}, Unread: []Unread{}}
	for _, block := range r.Blocks {
		if len(block.Prs) == 0 {
			out.Blocks = append(out.Blocks, block)
		}
	}
	return out
}

type ghTrunkCheckRuns struct {
	CheckRuns []struct {
		Name       string `json:"name"`
		Conclusion string `json:"conclusion"`
		HtmlUrl    string `json:"html_url"`
	} `json:"check_runs"`
}

var actionsUrlRe = regexp.MustCompile(`/actions/runs/(\d+)(?:/job/(\d+))?`)

// trunkCheckRuns reads the latest check runs of the trunk's head commit, once a minute at most.
func (r *Reader) trunkCheckRuns(ctx context.Context, gh Gh, dir string, trunk string) (ghTrunkCheckRuns, error) {
	key := "trunkchecks:" + trunk
	if value, ok := r.recall(key); ok {
		cached := value.(trunkChecksReading)
		return cached.runs, cached.err
	}
	out, err := callGh(ctx, gh, dir, "api", "repos/{owner}/{repo}/commits/"+trunk+"/check-runs?per_page=100&filter=latest")
	var runs ghTrunkCheckRuns
	if err == nil {
		err = json.Unmarshal(out, &runs)
	}
	// What could not be read is tried again after a while, never at each refresh.
	ttl := listTtl
	if err != nil {
		runs, ttl = ghTrunkCheckRuns{}, errorTtl
	}
	r.remember(key, trunkChecksReading{runs: runs, err: err}, ttl)
	return runs, err
}

type trunkChecksReading struct {
	runs ghTrunkCheckRuns
	err  error
}

func failedConclusion(conclusion string) bool {
	switch strings.ToLower(conclusion) {
	case "failure", "timed_out", "startup_failure":
		return true
	}
	return false
}

// trunkOnlyBlocks are the blocks of the scan failing on the trunk with advisories no pull request's block holds. A scan
// that fails with no advisory to read (it could not run, its report and log say none) makes no block: nothing is there to
// fix. gh failing says nothing.
func (r *Reader) trunkOnlyBlocks(ctx context.Context, gh Gh, in Input, existing []Block) []Block {
	if !in.watchesTrunk() {
		return nil
	}
	runs, err := r.trunkCheckRuns(ctx, gh, in.Dir, in.Trunk)
	if err != nil {
		return nil
	}
	taken := map[string]bool{}
	for _, block := range existing {
		for _, advisory := range block.Advisories {
			taken[advisory.Id] = true
		}
	}
	var blocks []Block
	seen := map[string]bool{}
	for _, run := range runs.CheckRuns {
		if !failedConclusion(run.Conclusion) {
			continue
		}
		check := Check{Name: run.Name, Failed: true}
		if m := actionsUrlRe.FindStringSubmatch(run.HtmlUrl); m != nil {
			check.RunId, _ = strconv.ParseInt(m[1], 10, 64)
			check.JobId, _ = strconv.ParseInt(m[2], 10, 64)
		}
		class := in.Policy.Classify(check)
		if class != ClassDeclared && class != ClassConfirmed {
			continue
		}
		var decl *Declaration
		if class == ClassDeclared {
			decl = in.Policy.Declaration
		}
		reading := r.ReadCheck(ctx, gh, in.Dir, decl, check)
		ids := Ids(reading.Advisories)
		if len(ids) == 0 {
			continue
		}
		fresh := false
		for _, id := range ids {
			fresh = fresh || !taken[id]
		}
		fingerprint := Fingerprint(ids)
		if !fresh || seen[fingerprint] {
			continue
		}
		seen[fingerprint] = true
		blocks = append(blocks, Block{Fingerprint: fingerprint, Check: CleanLine(run.Name, 80), Origin: class, Source: reading.Source,
			Advisories: reading.Advisories, TrunkFailing: true, TrunkNamed: true, TrunkRun: check.RunId, Shared: true, Prs: []BlockPr{}})
	}
	return blocks
}
