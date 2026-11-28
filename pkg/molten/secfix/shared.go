// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"path"
	"sort"
	"strings"
)

// Whether a scan's failure is shared (FR-REV-036 AC6, AC7): the pull requests that fail on one set of advisories are one
// block, and a block says, for each of its pull requests, why that pull request did not cause it.

// Block is one set of advisories that blocks one or more pull requests.
type Block struct {
	// Fingerprint keys the set: the sorted ids of its advisories, whoever lists them.
	Fingerprint string `json:"fingerprint"`
	// The scan check, as the first blocked pull request shows it.
	Check string `json:"check"`
	// OriginDeclared when the project declares every check that failed, else OriginConfirmed.
	Origin string `json:"origin"`
	// SourceReport when every blocked pull request's advisories come from a report, else SourceLog.
	Source     string     `json:"source"`
	Advisories []Advisory `json:"advisories"`
	// The same scan fails on the trunk, with advisories of this set (or ones that could not be read).
	TrunkFailing bool  `json:"trunkfailing,omitempty"`
	TrunkRun     int64 `json:"trunkrun,omitempty"`
	// TrunkNamed: the trunk's own scan names advisories of this set, as the trunk's report or log says (not only that the
	// scan fails there). What the trunk says is the project's own, and no pull request's.
	TrunkNamed bool `json:"trunknamed,omitempty"`
	// Shared: at least one of its pull requests did not cause it.
	Shared bool      `json:"shared"`
	Prs    []BlockPr `json:"prs"`
}

// TrustedForAuto says whether the block's advisories come from somewhere no pull request's author controls, which is what
// lets MoltenTerm start its fix without a click: the trunk's own scan names them, or at least two pull requests whose heads
// are in the repository itself (the listed ones: a fork's never are) fail on them. A single pull request's failed scan is
// text that pull request's CI wrote, and a pull request that touches no dependency file makes its block shared too: that
// alone never starts an agent. The developer's click may still launch it.
func (b Block) TrustedForAuto() bool {
	return (b.TrunkFailing && b.TrunkNamed) || len(b.Prs) >= 2
}

// BlockPr is one pull request of a block.
type BlockPr struct {
	Number int `json:"number"`
	// The scan checks of the pull request that failed.
	Checks []string `json:"checks"`
	// Shared: the failure is not the pull request's own; Reasons says why (ReasonTrunk, ReasonPrs, ReasonNoDependencyChange).
	Shared  bool     `json:"shared"`
	Reasons []string `json:"reasons,omitempty"`
}

// Offer is a check that looks like the project's scan and is not declared or confirmed: the developer answers once, and
// until then nothing acts on it.
type Offer struct {
	Check    string   `json:"check"`
	Workflow string   `json:"workflow,omitempty"`
	Ids      []string `json:"ids"`
	Prs      []int    `json:"prs"`
}

// Unread is a pull request whose scan failed and whose advisories could not be read: it keeps today's Analyze and
// resolve, and Cause (one of the Cause constants) says why.
type Unread struct {
	Pr     int      `json:"pr"`
	Checks []string `json:"checks"`
	Cause  string   `json:"cause"`
}

// Result is what a project's failed scan checks come to.
type Result struct {
	Blocks []Block  `json:"blocks"`
	Offers []Offer  `json:"offers"`
	Unread []Unread `json:"unread"`
}

// Restrict keeps what concerns the listed pull requests: a pull request that merged or closed since the assessment
// leaves its block, and a block with none left goes. A block that never had a pull request (the trunk's own, FR-REV-036
// AC16) stays: no pull request leaving can end it.
func (r Result) Restrict(listed map[int]bool) Result {
	out := Result{Blocks: []Block{}, Offers: []Offer{}, Unread: []Unread{}}
	for _, block := range r.Blocks {
		kept := []BlockPr{}
		shared := false
		for _, pr := range block.Prs {
			if listed[pr.Number] {
				kept = append(kept, pr)
				shared = shared || pr.Shared
			}
		}
		if len(kept) > 0 {
			block.Prs, block.Shared = kept, shared
			out.Blocks = append(out.Blocks, block)
		} else if len(block.Prs) == 0 {
			out.Blocks = append(out.Blocks, block)
		}
	}
	for _, offer := range r.Offers {
		prs := []int{}
		for _, number := range offer.Prs {
			if listed[number] {
				prs = append(prs, number)
			}
		}
		if len(prs) > 0 {
			offer.Prs = prs
			out.Offers = append(out.Offers, offer)
		}
	}
	for _, unread := range r.Unread {
		if listed[unread.Pr] {
			out.Unread = append(out.Unread, unread)
		}
	}
	return out
}

// PrOfBlock is the fingerprint of the block a pull request belongs to; empty when it belongs to none.
func (r Result) PrOfBlock(number int) string {
	for _, block := range r.Blocks {
		for _, pr := range block.Prs {
			if pr.Number == number {
				return block.Fingerprint
			}
		}
	}
	return ""
}

var dependencyFileNames = map[string]bool{
	"go.mod": true, "go.sum": true, "go.work": true, "go.work.sum": true,
	"package.json": true, "package-lock.json": true, "npm-shrinkwrap.json": true, "yarn.lock": true, "pnpm-lock.yaml": true,
	"bun.lock": true, "bun.lockb": true,
	"cargo.toml": true, "cargo.lock": true,
	"pipfile": true, "pipfile.lock": true, "poetry.lock": true, "pyproject.toml": true, "uv.lock": true,
	"gemfile": true, "gemfile.lock": true,
	"composer.json": true, "composer.lock": true,
	"pom.xml": true, "build.gradle": true, "build.gradle.kts": true, "gradle.lockfile": true,
	"mix.exs": true, "mix.lock": true, "pubspec.yaml": true, "pubspec.lock": true,
	"package.swift": true, "package.resolved": true, "podfile": true, "podfile.lock": true,
}

// IsDependencyFile tells whether a changed file is a dependency manifest or lockfile, at any depth, or one of the
// project's own (the declaration's dependencyfiles).
func IsDependencyFile(file string, extra []string) bool {
	file = strings.TrimPrefix(path.Clean(strings.ReplaceAll(file, "\\", "/")), "./")
	base := path.Base(file)
	lower := strings.ToLower(base)
	if dependencyFileNames[lower] || (strings.HasPrefix(lower, "requirements") && strings.HasSuffix(lower, ".txt")) {
		return true
	}
	for _, glob := range extra {
		if ok, _ := path.Match(glob, file); ok {
			return true
		}
		if ok, _ := path.Match(glob, base); ok {
			return true
		}
	}
	return false
}

func touchesDependencies(files []string, extra []string) bool {
	for _, file := range files {
		if IsDependencyFile(file, extra) {
			return true
		}
	}
	return false
}

type prFacts struct {
	Number     int
	HeadOid    string
	Checks     []string
	Origin     string
	Source     string
	Advisories []Advisory
	Files      []string
	FilesKnown bool
}

type trunkFacts struct {
	Failing    bool
	Run        int64
	Advisories []Advisory
}

func idSet(advisories []Advisory) map[string]bool {
	set := map[string]bool{}
	for _, advisory := range advisories {
		set[advisory.Id] = true
	}
	return set
}

func overlaps(a map[string]bool, b map[string]bool) bool {
	for id := range a {
		if b[id] {
			return true
		}
	}
	return false
}

func subset(a map[string]bool, b map[string]bool) bool {
	for id := range a {
		if !b[id] {
			return false
		}
	}
	return true
}

// buildBlocks groups the pull requests that fail on overlapping advisories into blocks, joins the trunk's own failure to
// the block whose advisories it shares, and decides for each pull request whether it caused the failure. The failure is
// shared with a pull request when the trunk fails on all its advisories (or on advisories nobody could read), when
// another pull request fails on one of them, or when the pull request changes no dependency file. A pull request that
// has none of the three brought its advisories itself: its block is not shared.
func buildBlocks(prs []prFacts, trunk trunkFacts, extra []string) []Block {
	n := len(prs)
	parent := make([]int, n+1)
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(i int) int {
		for parent[i] != i {
			parent[i] = parent[parent[i]]
			i = parent[i]
		}
		return i
	}
	union := func(i, j int) { parent[find(i)] = find(j) }
	ids := make([]map[string]bool, n)
	for i, pr := range prs {
		ids[i] = idSet(pr.Advisories)
	}
	trunkIds := idSet(trunk.Advisories)
	trunkNode := n
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			if overlaps(ids[i], ids[j]) {
				union(i, j)
			}
		}
		if trunk.Failing && overlaps(ids[i], trunkIds) {
			union(i, trunkNode)
		}
	}
	groups := map[int][]int{}
	for i := range prs {
		groups[find(i)] = append(groups[find(i)], i)
	}
	var blocks []Block
	for root, members := range groups {
		sort.Slice(members, func(a, b int) bool { return prs[members[a]].Number < prs[members[b]].Number })
		block := Block{Origin: OriginDeclared, Source: SourceReport, Prs: []BlockPr{}}
		var lists [][]Advisory
		joinedTrunk := trunk.Failing && find(trunkNode) == root
		// The scan fails on the trunk and its advisories could not be read: nothing says it is another set.
		trunkUnknown := trunk.Failing && len(trunkIds) == 0
		for _, i := range members {
			pr := prs[i]
			lists = append(lists, pr.Advisories)
			if block.Check == "" && len(pr.Checks) > 0 {
				block.Check = pr.Checks[0]
			}
			if pr.Origin != OriginDeclared {
				block.Origin = OriginConfirmed
			}
			if pr.Source != SourceReport {
				block.Source = SourceLog
			}
			entry := BlockPr{Number: pr.Number, Checks: pr.Checks}
			if trunk.Failing && (trunkUnknown || (joinedTrunk && subset(ids[i], trunkIds))) {
				entry.Reasons = append(entry.Reasons, ReasonTrunk)
			}
			for _, j := range members {
				if j != i && overlaps(ids[i], ids[j]) {
					entry.Reasons = append(entry.Reasons, ReasonPrs)
					break
				}
			}
			if pr.FilesKnown && !touchesDependencies(pr.Files, extra) {
				entry.Reasons = append(entry.Reasons, ReasonNoDependencyChange)
			}
			entry.Shared = len(entry.Reasons) > 0
			block.Shared = block.Shared || entry.Shared
			block.Prs = append(block.Prs, entry)
		}
		if joinedTrunk {
			lists = append(lists, trunk.Advisories)
		}
		block.TrunkFailing = joinedTrunk || trunkUnknown
		block.TrunkNamed = joinedTrunk
		if block.TrunkFailing {
			block.TrunkRun = trunk.Run
		}
		block.Advisories = mergeAdvisories(lists...)
		block.Fingerprint = Fingerprint(Ids(block.Advisories))
		blocks = append(blocks, block)
	}
	sort.Slice(blocks, func(i, j int) bool { return blocks[i].Prs[0].Number < blocks[j].Prs[0].Number })
	return blocks
}
